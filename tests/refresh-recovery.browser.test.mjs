import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { evaluationFixture, materializeEvaluationSource } from "./evaluation-fixture.mjs";
import { chooseTheme } from "./helpers.mjs";

const ready = page => page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
async function fixture(t, problem, { clock = false } = {}) {
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
    page.on("response", async response => {
        if (response.url().endsWith("/api/collection/now")) responses.push({ status: response.status(), body: await response.json() });
    });
    await page.goto(runtime.url); await ready(page); await page.evaluate(() => document.fonts.ready);
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

test("a real rejected source path offers one source repair, not an uncertain check or stored-read retry", { timeout: 60000 }, async t => {
    const app = await fixture(t, "paths"), { page } = app;
    const activity = await page.locator("#activityView").textContent();
    const initial = await page.locator("#checkActivity").boundingBox();
    await pointer(page, "#checkActivity");
    await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "error");
    assert.deepEqual(await page.locator("#checkActivity").boundingBox(), initial);
    assert.equal(await page.evaluate(() => scrollY), 0);
    const help = await page.locator("#freshHelp > summary").boundingBox();
    assert.ok(Math.abs(help.x - initial.x - initial.width - 16) < 0.02);
    const live = page.locator("#freshResult [role=status]");
    assert.equal(await live.getAttribute("aria-live"), "polite");
    assert.equal(await live.getAttribute("aria-atomic"), "true");
    for (const [theme, width] of [["light", 1440], ["dark", 1440], ["light", 375], ["dark", 375]]) {
        await chooseTheme(page, theme); await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(() => scrollTo(0, 0));
        await capture(page, `paths-${theme}-${width}`, { responses: app.responses, requests: app.requests });
    }
    assert.equal(app.responses[0].status, 422);
    assert.match(app.responses[0].body.error, /absolute data.db path and CLI session-state directory/);
    assert.equal(app.responses[0].body.code, "source_paths_invalid");
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
    await page.locator("#checkActivity").focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.locator("#freshHelp > summary").evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#freshHelp").evaluate(node => node.open), true);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
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
    await page.waitForFunction(() => document.querySelector("#freshStatus").textContent === "Stored view not updated.");
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

test("a missing approved metadata file is a known source failure without a replay latch", { timeout: 20000 }, async t => {
    const app = await fixture(t, "missing"), { page } = app;
    await pointer(page, "#checkActivity");
    await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "error");
    await capture(page, "missing-metadata", { responses: app.responses, requests: app.requests });
    assert.equal(app.responses[0].status, 503);
    assert.equal(app.responses[0].body.code, "source_metadata_unavailable");
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
