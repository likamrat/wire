import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, navigateMain, chooseTheme } from "./helpers.mjs";

async function setup(t, options = {}) {
    const { context } = await privateFixture(t);
    const sent = [];
    let respond;
    const runtime = await startServer(context, createExportController(context), {
        port: 0, collector: { timers: false },
        recorderDiagnostics: {
            timeoutMs: options.timeoutMs ?? 30000,
            testTransport: request => {
                sent.push(request);
                assert.equal(request.url, "https://graph.microsoft.com/v1.0/$metadata");
                assert.equal(request.headers.has("authorization"), false);
                assert.equal(request.headers.has("cookie"), false);
                assert.equal(request.redirect, "error");
                return new Promise((resolve, reject) => {
                    request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
                    respond = value => value instanceof Error ? reject(value) : resolve(new Response("SYNTHETIC_BODY_NEVER_LOGGED", { status: value }));
                });
            },
        },
    });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => {
        respond?.(new Error("fixture closing"));
        await browser.close(); await runtime.close();
        assert.deepEqual(errors, []);
    });
    await page.goto(runtime.url);
    await page.locator("#workspace[aria-busy=false]").waitFor();
    await navigateMain(page, "collection-status");
    assert.equal(await page.locator("#recorderDiagnostics").getAttribute("open"), null);
    await page.locator("#recorderDiagnostics>summary").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.querySelector("#recordBtn").disabled);
    return { page, runtime, context, sent, respond: value => respond(value) };
}

async function begin(page) {
    await page.locator("#recordBtn").focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Send public request", exact: true }).click();
}

test("metadata action shows pending feedback beside its button, not only above the page", { timeout: 20000 }, async t => {
    const { page, sent } = await setup(t);
    let release;
    const held = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/record", async route => {
        await held;
        await route.fulfill({ status: 503, json: { error: "Isolated fixture service unavailable." } });
    });
    await begin(page);
    await page.waitForFunction(() => document.querySelector("#recordBtn").disabled);
    assert.equal(await page.locator("#recorderStatus").count(), 1, "Action needs its own visible live feedback instead of an offscreen notice");
    assert.equal(await page.locator("#recorderStatus").isVisible(), true);
    assert.match(await page.locator("#recorderStatus").innerText(), /request|record/i);
    assert.equal(await page.locator("#recordBtn").getAttribute("aria-busy"), "true");
    assert.equal(await page.evaluate(() => document.activeElement.id), "recorderStatus", "Confirmation restores focus to the adjacent pending result, not a disabled button");
    release();
    await page.waitForFunction(() => document.querySelector("#recordBtn").textContent === "Check saved result");
    assert.match(await page.locator("#recorderStatus").innerText(), /unavailable.*not repeat|unavailable.*another request/i);
    assert.equal(sent.length, 0);
});

test("real click route recorder path persists exact outcomes without workplace counts, duplicates or navigation replay", { timeout: 40000 }, async t => {
    const { page, context, sent, respond, runtime } = await setup(t);
    const before = await loadBoardState(context);
    assert.match(await page.locator("#pageIntro").innerText(), /approved local history collection/);
    assert.match(await page.locator("#recorderPurpose").innerText(), /not needed/);
    assert.equal(sent.length, 0, "Opening diagnostics is read-only");
    const ids = [];
    for (const [reply, expected] of [[200, /HTTP 200 received/], [503, /returned HTTP 503/], [new Error("fixture network failure"), /No HTTP response received/]]) {
        await begin(page);
        await page.waitForFunction(() => document.querySelector("#recorderStatus").textContent.includes("Public request in progress"));
        assert.equal(await page.locator("#recorderStatus").getAttribute("aria-live"), "polite");
        await page.locator("#recordBtn").evaluate(node => { node.click(); node.click(); });
        const count = sent.length;
        await navigateMain(page, "home");
        respond(reply);
        await page.waitForFunction(() => !document.querySelector("#recordBtn").disabled);
        assert.match(page.url(), /#home/, "Completion must not navigate back or steal reading context");
        await navigateMain(page, "collection-status");
        assert.match(await page.locator("#recorderStatus").innerText(), expected);
        assert.equal(sent.length, count);
        assert.match(await page.locator("#recorderEvidence").innerText(), /http-records\/.*\.json/);
        ids.push((await page.locator("#recorderEvidence").innerText()).match(/Attempt ([a-f0-9-]+)\./)[1]);
    }
    assert.equal(new Set(ids).size, 3);
    const names = await readdir(path.join(context.dataDir, "http-records"));
    assert.equal(names.length, 3);
    const records = await Promise.all(names.map(name => readFile(path.join(context.dataDir, "http-records", name), "utf8").then(JSON.parse)));
    assert.deepEqual(records.map(record => record.status).sort(), [200, 503, null].sort());
    for (const record of records) {
        assert.equal(record.synthetic, true);
        assert.equal(record.classification, "synthetic-http-fixture");
        assert.equal(record.observedGraphHttp, false);
        assert.ok(ids.includes(record.correlation.scenarioId.replace("graph-", "")));
        assert.doesNotMatch(JSON.stringify(record), /SYNTHETIC_BODY_NEVER_LOGGED|fixture network failure/);
    }
    const after = await loadBoardState(context);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.cards, before.cards);
    assert.deepEqual(after.exports, before.exports);
    await page.reload();
    await page.locator("#workspace[aria-busy=false]").waitFor();
    await page.locator("#recorderDiagnostics>summary").click();
    await page.waitForFunction(() => !document.querySelector("#recordBtn").disabled);
    assert.match(await page.locator("#recorderStatus").innerText(), /No HTTP response received/);
    assert.match(await page.locator("#recorderEvidence").innerText(), new RegExp(ids[2]));
    assert.equal(sent.length, 3);
    const proofDir = process.env.RECORDER_PROOF_DIR;
    if (proofDir) await mkdir(proofDir, { recursive: true });
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
            await page.locator("#recorderDiagnostics").scrollIntoViewIfNeeded();
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${theme}/${width}/${scale}: page overflow`);
            const box = await page.locator("#recordBtn").boundingBox();
            assert.ok(box.height >= 44);
            assert.equal(await page.locator("#recorderStatus").evaluate(node => node.scrollWidth <= node.clientWidth), true);
            if (proofDir) {
                await page.evaluate(() => window.scrollTo(0, 0));
                await page.screenshot({ path: path.join(proofDir, `recorder-${theme}-${width}-${scale * 100}.png`), fullPage: true });
            }
        }
    }
    assert.equal(runtime.server.listening, true);
});

test("no response times out and retains a no-response attempt, not a successful HTTP call", { timeout: 15000 }, async t => {
    const { page, sent, context } = await setup(t, { timeoutMs: 150 });
    await begin(page);
    await page.waitForFunction(() => document.querySelector("#recorderStatus").textContent.includes("Timed out"));
    assert.match(await page.locator("#recorderStatus").innerText(), /not a successful HTTP call/);
    const names = await readdir(path.join(context.dataDir, "http-records"));
    const record = JSON.parse(await readFile(path.join(context.dataDir, "http-records", names[0]), "utf8"));
    assert.equal(record.transportError, "TimeoutError");
    assert.equal(record.status, null);
    assert.equal(sent.length, 1);
});

test("lost acceptance response checks the original persisted attempt without replay", { timeout: 15000 }, async t => {
    const { page, sent, respond } = await setup(t);
    let mutations = 0;
    await page.route("**/api/record", async route => {
        mutations++;
        await route.fetch();
        await route.abort("failed");
    });
    await begin(page);
    await page.waitForFunction(() => document.querySelector("#recordBtn").textContent === "Check saved result");
    assert.equal(await page.locator("#recordBtn").isEnabled(), true);
    assert.match(await page.locator("#recorderStatus").innerText(), /may still complete/);
    respond(200);
    await page.locator("#recordBtn").click();
    await page.waitForFunction(() => document.querySelector("#recorderStatus").textContent.includes("HTTP 200 received"));
    assert.equal(mutations, 1);
    assert.equal(sent.length, 1);
});

test("reload during pending recording reads the same attempt and does not dispatch again", { timeout: 15000 }, async t => {
    const { page, sent, respond } = await setup(t);
    await begin(page);
    await page.waitForFunction(() => document.querySelector("#recorderStatus").textContent.includes("Public request in progress"));
    const identity = (await page.locator("#recorderEvidence").innerText()).match(/Attempt ([a-f0-9-]+)\./)[1];
    await page.reload();
    await page.locator("#workspace[aria-busy=false]").waitFor();
    await page.locator("#recorderDiagnostics>summary").click();
    await page.waitForFunction(() => document.querySelector("#recorderStatus").textContent.includes("Public request in progress"));
    assert.match(await page.locator("#recorderEvidence").innerText(), new RegExp(identity));
    assert.equal(await page.locator("#recordBtn").isDisabled(), true);
    respond(200);
    await page.waitForFunction(() => document.querySelector("#recorderStatus").textContent.includes("HTTP 200 received"));
    assert.match(await page.locator("#recorderEvidence").innerText(), new RegExp(identity));
    assert.equal(sent.length, 1);
});

test("offline activation stays uncertain, can read after reconnect, and never replays", { timeout: 15000 }, async t => {
    const { page, sent } = await setup(t);
    await page.context().setOffline(true);
    await begin(page);
    await page.waitForFunction(() => document.querySelector("#recordBtn").textContent === "Check saved result");
    assert.match(await page.locator("#recorderStatus").innerText(), /unavailable or timed out/);
    await page.context().setOffline(false);
    await page.locator("#recordBtn").click();
    await page.waitForFunction(() => document.querySelector("#recorderStatus").textContent.includes("No saved result"));
    assert.equal(sent.length, 0);
    assert.equal(await page.locator("#recordBtn").innerText(), "Check saved result");
});

test("expired capability renews but rejects the mutation; new confirmation is required", { timeout: 15000 }, async t => {
    const { page, sent } = await setup(t);
    const statusRequest = page.waitForRequest("**/api/record/status");
    await page.locator("#recorderDiagnostics>summary").click();
    await page.locator("#recorderDiagnostics>summary").click();
    const request = await statusRequest;
    await page.waitForFunction(() => !document.querySelector("#recordBtn").disabled);
    await page.evaluate(async capability => {
        await fetch("/api/session/release", { method: "POST", headers: { "Content-Type": "application/json", "X-Board-Capability": capability }, body: "{}" });
    }, request.headers()["x-board-capability"]);
    await begin(page);
    await page.waitForFunction(() => document.querySelector("#recorderStatus").textContent.includes("not started"));
    assert.match(await page.locator("#recorderStatus").innerText(), /not replayed/);
    assert.equal(sent.length, 0);
    assert.equal(await page.locator("#recordBtn").isEnabled(), true);
});
