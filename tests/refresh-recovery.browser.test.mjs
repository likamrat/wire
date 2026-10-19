import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { evaluationFixture, materializeEvaluationSource } from "./evaluation-fixture.mjs";
import { chooseTheme, navigateMain, navigateSettings } from "./helpers.mjs";

const ready = page => page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
async function fixture(t, problem, { clock = false, decodeResponse = response => response.json() } = {}) {
    const denied = [], errors = [], requests = [], responses = [], cleanups = [], sourceBytes = [];
    let runtime, browser, configFile, configBefore;
    t.after(async () => {
        try {
            await browser?.close(); await runtime?.close();
            if (configFile && configBefore) assert.deepEqual(await readFile(configFile), configBefore);
            for (const [file, bytes] of sourceBytes) assert.deepEqual(await readFile(file), bytes);
            assert.deepEqual(denied, []); assert.deepEqual(errors, []);
        } finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
    });
    const deny = name => () => { denied.push(name); throw new Error(`Denied synthetic recovery operation: ${name}`); };
    const app = await evaluationFixture({ after: cleanup => cleanups.push(cleanup) }, deny("provider"));
    if (problem !== "unapproved") {
        await materializeEvaluationSource(app);
        for (const file of [app.config.appDbPath, ...app.inputs.map(input => path.join(app.config.sessionRoot, input.record.sourceSessionId, "events.jsonl"))]) {
            sourceBytes.push([file, await readFile(file)]);
        }
        configFile = path.join(app.context.dataDir, "collector", "config.json");
        const config = JSON.parse(await readFile(configFile, "utf8"));
        // Simulate persisted legacy/broken configuration, never weaken configure() validation.
        if (problem === "paths") config.appDbPath = path.join(app.context.dataDir, "old-name.db");
        if (problem === "missing") config.appDbPath = path.join(app.context.dataDir, "missing", "data.db");
        await writeFile(configFile, JSON.stringify(config));
        configBefore = await readFile(configFile);
    }
    const before = await loadBoardState(app.context);
    const options = { port: 0, collector: { timers: false },
        evaluation: { discover: deny("evaluation discovery"), readSource: deny("evaluation source"), evaluatorFactory: deny("evaluator") } };
    runtime = await startServer(app.context, createExportController(app.context), options);
    options.port = Number(new URL(runtime.url).port);
    browser = await chromium.launch({ ...(process.env.WIRE_RECOVERY_HEADED ? { channel: "msedge", headless: false } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    if (clock) await page.clock.install();
    page.setDefaultTimeout(10000);
    const origin = new URL(runtime.url).origin;
    await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin || request.method() !== "GET" && ![
            "/api/snapshot", "/api/collection/status", "/api/collection/now", "/api/evaluation/automatic/summary", "/api/session",
        ].includes(url.pathname)) {
            denied.push(`${request.method()} ${url.origin === origin ? url.pathname : "external"}`);
            return route.abort("blockedbyclient");
        }
        return route.continue();
    });
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") requests.push(new URL(request.url()).pathname); });
    page.on("response", response => {
        if (response.url().endsWith("/api/collection/now")) {
            const status = response.status();
            responses.push(decodeResponse(response).then(body => ({ status, body })));
        }
    });
    await page.goto(runtime.url); await ready(page); await page.evaluate(() => document.fonts.ready);
    if (await page.locator("#activityUpdateToggle").getAttribute("aria-expanded") === "false") await page.locator("#activityUpdateToggle").click();
    return { ...app, runtime, page, requests, responses, before,
        restart: async () => { runtime = await startServer(app.context, createExportController(app.context), options); return runtime; } };
}

async function pointer(page, selector) {
    const box = await page.locator(selector).boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= 1000, "Pointer target is already visible; no locator auto-scroll");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function capture(page, name, observations = {}) {
    if (!process.env.WIRE_RECOVERY_PROOFS) return;
    const root = process.env.WIRE_RECOVERY_PROOFS;
    await mkdir(root, { recursive: true });
    await page.screenshot({ path: path.join(root, name + ".png"), fullPage: true });
    const box = await page.locator("#freshActivity").boundingBox();
    if (box && box.y >= 0 && box.y + box.height <= 1000) {
        await page.screenshot({ path: path.join(root, name + "-detail.png"), clip: box });
    }
    await writeFile(path.join(root, name + ".json"), JSON.stringify({ ...observations,
        text: await page.locator("#freshActivity").innerText(),
        paused: await page.locator("#collectionNotice").innerText(),
        geometry: await page.locator("#freshActivity").evaluate(host => ({
            scrollY, width: innerWidth, documentWidth: document.documentElement.scrollWidth,
            phase: host.dataset.phase, focus: document.activeElement?.id,
            live: host.querySelector('[role="status"]').outerHTML,
            controls: [...host.querySelector(".fresh-controls").children].map(node => node.id || node.className),
        })),
    }, null, 2));
}

async function refreshTooltip(page) {
    const control = page.locator("#checkActivity");
    await expect(control).toBeEnabled();
    await page.keyboard.press("Tab");
    await control.focus();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    const text = (await tooltip.textContent()).trim();
    await page.keyboard.press("Escape");
    await expect(tooltip).not.toBeVisible();
    return text;
}

for (const [problem, code] of [["paths", "source_paths_invalid"], ["missing", "source_metadata_unavailable"]]) {
    test(`Settings ${code} help describes the actual stored read without replaying the rejected source check`, { timeout: 30000 }, async t => {
        const app = await fixture(t, problem), { page } = app;
        await page.locator("#checkActivity").focus();
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => document.getElementById("freshActivity").dataset.phase === "error");
        const [rejection] = await Promise.all(app.responses);
        assert.equal(rejection.body.code, code, "This is a real collector rejection, not an injected UI state");
        await navigateMain(page, "settings");
        await navigateSettings(page, "connection");
        const tooltip = await refreshTooltip(page);
        const effect = {
            visible: await page.locator("#settingsRefreshContext").isVisible(),
            text: await page.locator("#settingsRefreshContext").textContent(),
        };
        const sourceChecks = app.requests.filter(value => value === "/api/collection/now").length;
        const snapshotReads = app.requests.filter(value => value === "/api/snapshot").length;
        await capture(page, `settings-help-${code}`, { code, tooltip, effect, sourceChecks, snapshotReads });
        const storedResponse = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
        await page.locator("#checkActivity").focus();
        await page.keyboard.press("Enter");
        assert.equal((await storedResponse).status(), 200);
        await ready(page);
        await expect(page.locator("#freshContextMessage")).toContainText("Stored activity refreshed");
        assert.equal(app.requests.filter(value => value === "/api/collection/now").length, sourceChecks);
        assert.equal(sourceChecks, 1);
        assert.equal(app.requests.filter(value => value === "/api/snapshot").length, snapshotReads + 1);
        assert.deepEqual(await loadBoardState(app.context), app.before);
        t.diagnostic(JSON.stringify({ code, tooltip, effect, sourceChecks, storedReadsAdded: 1 }));
        assert.equal(tooltip, "Read stored activity. No source check will be repeated.");
        assert.equal(effect.visible, true);
        assert.equal(effect.text, "Read stored activity only. No new history check will be sent.");
    });

    test(`Settings exit preserves dynamic Refresh help after ${code} recovery and return to normal intent`, { timeout: 30000 }, async t => {
        const app = await fixture(t, problem), { page } = app;
        const normalHelp = "Refresh approved local history. Paused collection stays paused.";
        assert.equal(await refreshTooltip(page), normalHelp);
        await page.locator("#checkActivity").focus();
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => document.getElementById("freshActivity").dataset.phase === "error");
        const [rejection] = await Promise.all(app.responses);
        assert.equal(rejection.body.code, code);
        await navigateMain(page, "settings");
        await navigateSettings(page, "connection");
        await navigateMain(page, "analyze");
        const analyzeRecovery = await refreshTooltip(page);
        await navigateMain(page, "collection-status");
        await expect(page.locator("#collectionStatusView")).toBeVisible();
        const statusRecovery = await refreshTooltip(page);
        const sourceChecks = app.requests.filter(value => value === "/api/collection/now").length;
        const snapshotReads = app.requests.filter(value => value === "/api/snapshot").length;
        const storedResponse = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
        await page.locator("#checkActivity").focus();
        await page.keyboard.press("Enter");
        assert.equal((await storedResponse).status(), 200);
        await ready(page);
        await expect(page.locator("#freshContextMessage")).toContainText("Stored activity refreshed");
        await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "complete");
        const statusNormal = await refreshTooltip(page);
        await navigateMain(page, "analyze");
        const analyzeNormal = await refreshTooltip(page);
        assert.equal(app.requests.filter(value => value === "/api/collection/now").length, sourceChecks);
        assert.equal(sourceChecks, 1);
        assert.equal(app.requests.filter(value => value === "/api/snapshot").length, snapshotReads + 1);
        assert.deepEqual(await loadBoardState(app.context), app.before);
        t.diagnostic(JSON.stringify({ code, analyzeRecovery, statusRecovery, statusNormal, analyzeNormal, sourceChecks, storedReadsAdded: 1 }));
        for (const text of [analyzeRecovery, statusRecovery]) assert.equal(text, "Read stored activity. No source check will be repeated.");
        for (const text of [statusNormal, analyzeNormal]) assert.equal(text, normalHelp);
    });
}

test("a real rejected source path offers one source repair, not an uncertain check or stored-read retry", { timeout: 60000 }, async t => {
    const app = await fixture(t, "paths"), { page } = app;
    const activity = await page.locator("#activityView").textContent();
    const initial = await page.locator("#checkActivity").boundingBox();
    await pointer(page, "#checkActivity");
    await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "error");
    const after = await page.locator("#checkActivity").boundingBox();
    assert.equal(after.x, initial.x); assert.equal(after.y, initial.y);
    assert.equal(await page.evaluate(() => scrollY), 0);
    const result = await page.locator("#freshResult").boundingBox();
    assert.ok(result.y >= initial.y + initial.height, "Recovery stays below its contextual action");
    assert.equal(await page.locator("#activityUpdateSlot #checkActivity").count(), 1);
    const live = page.locator("#freshResult [role=status]");
    assert.equal(await live.getAttribute("aria-live"), "polite");
    assert.equal(await live.getAttribute("aria-atomic"), "true");
    const responses = await Promise.all(app.responses);
    assert.equal(responses.length, 1);
    for (const [theme, width] of [["light", 1440], ["dark", 1440], ["light", 375], ["dark", 375]]) {
        await chooseTheme(page, theme); await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(() => scrollTo(0, 0));
        await capture(page, `paths-${theme}-${width}`, { responses, requests: app.requests });
    }
    assert.equal(responses[0].status, 422);
    assert.match(responses[0].body.error, /absolute data.db path and CLI session-state directory/);
    assert.equal(responses[0].body.code, "source_paths_invalid");
    assert.equal(await page.locator("#freshStatus").innerText(), "Source paths need attention.");
    assert.match(await page.locator("#freshContextMessage").innerText(), /Previous view kept.*data.db.*session-state.*Collection is paused/s);
    assert.equal(await page.locator("#collectionNotice").isVisible(), false, "Paused fact belongs to this recovery, not a duplicate banner");
    assert.equal(await page.locator("#refreshBtn").isVisible(), false, "A successful stored read cannot repair source paths");
    assert.equal(await page.locator("#freshIssues").innerText(), "Review source");
    assert.equal(await page.locator("#freshIssues").getAttribute("href"), "#settings?section=connection&setting=source-paths");
    assert.equal(await page.locator("#activityView").textContent(), activity);
    assert.deepEqual(await loadBoardState(app.context), app.before);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("workiq-evidence.source-check.v1")), null);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator("#freshIssues").focus();
    assert.equal(await page.locator("#freshIssues").evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Enter"); await ready(page);
    assert.equal(await page.locator("#approvedSourceDetails").isVisible(), true);
    assert.equal(await page.locator("#editSource").isVisible(), true);
    assert.equal(await page.locator("#freshStatus").innerText(), "Source paths need attention.");
    await page.locator("#checkActivity").focus(); await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "complete");
    assert.equal(await page.locator("#freshStatus").innerText(), "Source paths need attention.");
    assert.match(await page.locator("#freshContextMessage").innerText(), /Stored activity refreshed.*paths must be absolute/);
    assert.equal(app.requests.filter(value => value === "/api/collection/now").length, 1);
    assert.equal((await app.runtime.collector.status()).config.enabled, false);
});

test("polling consolidates only the same source failure and keeps unrelated or unknown status visible", { timeout: 30000 }, async t => {
    const app = await fixture(t, "paths", { clock: true }), { page } = app;
    await pointer(page, "#checkActivity");
    await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "error");
    let variation = {}, polls = 0, unavailable = false;
    await page.route("**/api/collection/status", async route => {
        polls++;
        if (unavailable) return route.abort("connectionreset");
        const response = await route.fetch(), status = await response.json();
        await route.fulfill({ response, json: { ...status, ...variation } });
    });
    async function poll() {
        const previous = polls, done = page.waitForResponse(response => response.url().endsWith("/api/collection/status"));
        await page.clock.runFor(5100); await done;
        await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
        assert.equal(polls, previous + 1);
    }
    for (let index = 0; index < 2; index++) {
        await poll();
        assert.equal(await page.locator("#collectionNotice").isVisible(), false);
        assert.match(await page.locator("#freshContextMessage").innerText(), /Collection is paused/);
    }
    for (const changed of [{ configVersion: "different-source" }, { revision: app.before.revision + 1 },
        { lastCheck: { id: "different-receipt" } }, { error: "An unrelated collection failure" },
        { state: "stopped" }, { state: "unknown" }, { revision: undefined }]) {
        variation = changed;
        await poll();
        await page.locator("#collectionNotice:visible").waitFor();
        assert.equal(await page.locator("#collectionNotice").isVisible(), true, JSON.stringify(changed));
    }
    variation = {};
    await poll();
    assert.equal(await page.locator("#collectionNotice").isVisible(), false);
    unavailable = true;
    const failed = page.waitForEvent("requestfailed", request => request.url().endsWith("/api/collection/status"));
    await page.clock.runFor(5100); await failed;
    await page.locator("#collectionNotice:visible").waitFor();
    assert.match(await page.locator("#collectionNotice").innerText(), /runtime unavailable/);
    assert.doesNotMatch(await page.locator("#freshContextMessage").innerText(), /Collection is paused/);
    assert.equal(app.requests.filter(value => value === "/api/collection/now").length, 1);
    assert.deepEqual(await loadBoardState(app.context), app.before);
});

test("a stored-read failure after an unknown check has one owned recovery and never replays the check", { timeout: 30000 }, async t => {
    const app = await fixture(t), { page } = app;
    await page.route("**/api/collection/now", async route => {
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        await route.abort("connectionreset");
    }, { times: 1 });
    await pointer(page, "#checkActivity");
    await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "error");
    const committed = await loadBoardState(app.context);
    assert.match(await page.locator("#freshContextMessage").innerText(), /outcome unknown.*not be repeated/);
    assert.equal(await page.locator("#freshIssues").isVisible(), false);
    await page.route("**/api/snapshot", route => route.abort("connectionreset"), { times: 1 });
    await page.getByRole("button", { name: "Read stored activity", exact: true }).focus();
    await page.keyboard.press("Enter"); await ready(page);
    await page.waitForFunction(() => document.querySelector("#freshStatus").textContent.trim() === "Stored view not updated.");
    assert.equal(await page.locator("#checkActivity").isVisible(), false, "Only the read-only recovery owns Refresh during this failure");
    assert.equal(await page.locator("#message").isVisible(), false);
    assert.equal(await page.locator("#collectionNotice").isVisible(), false);
    assert.equal(await page.getByRole("button", { name: "Read stored activity", exact: true }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).count(), 0);
    await capture(page, "unknown-then-stored-read-failure", { requests: app.requests });
    await page.locator("#refreshBtn").focus(); await page.keyboard.press("Enter"); await ready(page);
    await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "unconfirmed");
    assert.match(await page.locator("#freshStatus").innerText(), /Stored data refreshed; source check unconfirmed/);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("workiq-evidence.source-check.v1")), "pending");
    assert.equal(app.requests.filter(value => value === "/api/collection/now").length, 1);
    assert.deepEqual(await loadBoardState(app.context), committed);
    await capture(page, "unknown-stored-read-recovered", { requests: app.requests });
});

test("missing-metadata status observation awaits its real response when Node decoding trails the browser error", { timeout: 20000 }, async t => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const app = await fixture(t, "missing", { decodeResponse: async response => { await gate; return response.json(); } });
    const { page } = app, failedRequests = [];
    page.on("requestfailed", request => failedRequests.push(request.url()));
    const response = page.waitForResponse(value => value.request().method() === "POST" && value.url().endsWith("/api/collection/now"));
    await pointer(page, "#checkActivity");
    const received = await response;
    assert.equal(received.status(), 503, "The real source response arrived; this is not absent transport");
    await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "error");
    assert.equal(await page.locator("#freshStatus").innerText(), "Local history could not be read.");
    const observation = Promise.all(app.responses);
    release();
    const [observed] = await observation;
    assert.equal(observed.status, 503);
    assert.equal(observed.body.code, "source_metadata_unavailable");
    assert.deepEqual(failedRequests, []);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("workiq-evidence.source-check.v1")), null);
    assert.equal((await app.runtime.collector.status()).config.enabled, false);
    assert.deepEqual(await loadBoardState(app.context), app.before);
    assert.equal(app.requests.filter(value => value === "/api/collection/now").length, 1);
});

test("a missing approved metadata file is a known source failure without a replay latch", { timeout: 20000 }, async t => {
    const app = await fixture(t, "missing"), { page } = app;
    await pointer(page, "#checkActivity");
    await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "error");
    const responses = await Promise.all(app.responses);
    assert.equal(responses.length, 1);
    await capture(page, "missing-metadata", { responses, requests: app.requests });
    assert.equal(responses[0].status, 503);
    assert.equal(responses[0].body.code, "source_metadata_unavailable");
    assert.equal(await page.locator("#freshStatus").innerText(), "Local history could not be read.");
    assert.equal(await page.locator("#refreshBtn").isVisible(), false);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("workiq-evidence.source-check.v1")), null);
    assert.deepEqual(await loadBoardState(app.context), app.before);
    assert.equal(app.requests.filter(value => value === "/api/collection/now").length, 1);
});

for (const responseKind of ["unclassified-503", "unclassified-422", "malformed-receipt"]) {
    test(`${responseKind} after actual collection remains unknown through stored recovery`, { timeout: 20000 }, async t => {
        const app = await fixture(t), { page } = app;
        await page.route("**/api/collection/now", async route => {
            const response = await route.fetch(), body = await response.json();
            assert.equal(response.status(), 200);
            assert.ok(body.check.id);
            await route.fulfill(responseKind.startsWith("unclassified-")
                ? { status: Number(responseKind.slice("unclassified-".length)), json: { code: "INTERNAL", error: "Invented response failure after collection" } }
                : { response, json: { ...body, check: { ...body.check, id: null } } });
        }, { times: 1 });
        await pointer(page, "#checkActivity");
        await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "error");
        const committed = await loadBoardState(app.context);
        assert.match(await page.locator("#freshContextMessage").innerText(), /outcome unknown/);
        assert.equal(await page.locator("#freshIssues").isVisible(), false);
        assert.equal(await page.evaluate(() => sessionStorage.getItem("workiq-evidence.source-check.v1")), "pending");
        await page.locator("#refreshBtn").focus(); await page.keyboard.press("Enter"); await ready(page);
        await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "unconfirmed");
        assert.equal(await page.locator("#freshActivity").getAttribute("data-check-id"), "");
        assert.equal(app.requests.filter(value => value === "/api/collection/now").length, 1);
        assert.deepEqual(await loadBoardState(app.context), committed);
        assert.equal((await app.runtime.collector.status()).config.enabled, false);
        await capture(page, responseKind, { requests: app.requests });
    });
}

test("an unapproved stored-read failure recovers after a real runtime restart without collecting", { timeout: 25000 }, async t => {
    const app = await fixture(t, "unapproved"), { page } = app;
    const previous = await page.locator("#activityCount").innerText();
    await app.runtime.close();
    await pointer(page, "#checkActivity");
    await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "error");
    assert.equal(await page.locator("#freshStatus").innerText(), "Stored view not updated.");
    assert.match(await page.locator("#freshContextMessage").innerText(), /Previous view kept.*WIRE could not be reached/);
    assert.equal(await page.locator("#message").isVisible(), false);
    assert.equal(await page.locator("#activityCount").innerText(), previous);
    assert.match(await page.locator("#periodResult").innerText(), /Previous results/);
    await capture(page, "stopped-runtime-stored-read", { requests: app.requests });
    const runtime = await app.restart();
    await page.locator("#refreshBtn").focus(); await page.keyboard.press("Enter"); await ready(page);
    await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "complete");
    assert.equal(await page.locator("#freshStatus").innerText(), "Stored activity refreshed.");
    assert.equal(await page.locator("#checkActivity").evaluate(node => node === document.activeElement), true);
    assert.doesNotMatch(await page.locator("#periodResult").innerText(), /Previous results/);
    assert.equal(app.requests.filter(value => value === "/api/collection/now").length, 0);
    assert.equal((await runtime.collector.status()).config, null);
    assert.deepEqual(await loadBoardState(app.context), app.before);
});
