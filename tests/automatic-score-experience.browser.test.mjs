import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { evaluationFixture, materializeEvaluationSource } from "./evaluation-fixture.mjs";
import { navigateMain, navigateSettings } from "./helpers.mjs";

async function fixture(t) {
    const cleanup = [], f = await evaluationFixture({ after: action => cleanup.push(action) });
    await materializeEvaluationSource(f);
    const runtime = await startServer(f.context, createExportController(f.context), {
        port: 0, collector: { timers: false }, evaluation: { evaluatorFactory: f.options.evaluatorFactory },
    });
    const browser = await chromium.launch();
    t.after(async () => { try { await browser.close(); await runtime.close(); } finally { for (const action of cleanup.reverse()) await action(); } });
    await runtime.collector.setEnabled(true);
    await runtime.collector.collectNow();
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const errors = [], routes = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") routes.push(new URL(request.url()).pathname); });
    t.after(() => assert.deepEqual(errors, []));
    await page.goto(runtime.url + "#settings?section=ai&setting=automatic-scores");
    await page.locator("#automaticScoreSetup").getByRole("button", { name: "Set up automatic scores" }).waitFor();
    return { ...f, runtime, page, routes };
}
async function review(page) {
    await navigateSettings(page, "ai");
    await page.locator("#automaticScoreSetup").getByRole("button", { name: "Set up automatic scores" }).click();
    const dialog = page.getByRole("dialog", { name: "Automatic scores", exact: true });
    await dialog.locator(".automatic-score-chats").waitFor();
    for (const choice of await dialog.locator(".automatic-score-chats input").all()) await choice.check();
    await dialog.getByLabel("Total assessment allowance", { exact: true }).fill("2");
    await dialog.getByLabel("Total budget (AI credits)", { exact: true }).fill("60");
    await dialog.getByRole("checkbox", { name: /Allow this evidence/ }).check();
    return dialog;
}
async function settle(context, count) {
    const deadline = Date.now() + 10000;
    do {
        const state = await loadBoardState(context), runs = state.personalEvaluation?.modelEvaluation?.runs ?? [];
        if (runs.length >= count && runs.every(run => !["queued", "running"].includes(run.phase))) return state;
        await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.fail("The controlled automatic model did not finish.");
}

test("normal AI reviews approval produces scores automatically and Stop remains separate from Recorded replies", { timeout: 45000 }, async t => {
    const f = await fixture(t), { page, runtime } = f;
    const saving = page.locator("#assessmentSetup").getByRole("checkbox");
    await navigateSettings(page, "privacy");
    await saving.waitFor();
    assert.equal(await saving.isChecked(), false);
    assert.equal(f.calls.length, 0);
    const dialog = await review(page);
    for (const [theme, width, zoom] of [["light", 1200, 100], ["dark", 375, 100], ["dark", 320, 200]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(({ theme, zoom }) => {
            document.documentElement.dataset.evidenceTheme = theme;
            document.documentElement.style.fontSize = zoom + "%";
        }, { theme, zoom });
        await dialog.getByRole("button", { name: "Approve automatic scores", exact: true }).scrollIntoViewIfNeeded();
        assert.equal(await dialog.locator(".assessment-dialog-body").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
        if (process.env.WIRE_AUTO_CONNECTED_PROOFS) {
            await mkdir(process.env.WIRE_AUTO_CONNECTED_PROOFS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WIRE_AUTO_CONNECTED_PROOFS, `${theme}-${width}-${zoom}.png`) });
        }
    }
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; document.documentElement.dataset.evidenceTheme = "light"; });
    const approved = page.waitForResponse(response => response.url().endsWith("/api/evaluation/automatic/approve"));
    await dialog.getByRole("button", { name: "Approve automatic scores" }).click();
    const result = await approved;
    assert.equal(result.status(), 200, await result.text());
    await dialog.waitFor({ state: "hidden" });
    await settle(f.context, 1);
    await runtime.collector.collectNow();
    await settle(f.context, 2);
    await navigateMain(page, "home");
    const accuracy = page.locator('#homeInsights [data-dimension="accuracy"]').filter({ hasText: "Model assessment" });
    await accuracy.waitFor();
    assert.equal(await accuracy.locator(".assessment-value").innerText(), "50%");
    assert.equal(f.calls.length, 2);
    assert.equal(f.routes.filter(route => route === "/api/evaluation/automatic/approve").length, 1);
    assert.equal(f.routes.some(route => route === "/api/evaluation/start" || route === "/api/collection/now"), false);
    await page.evaluate(() => sessionStorage.setItem("wire.automaticScore.pending", "INVALID"));
    await page.goto(runtime.url + "#settings?section=ai&setting=automatic-scores");
    const stop = page.locator("#automaticScoreSetup").getByRole("button", { name: "Stop automatic scores" });
    await stop.waitFor();
    await stop.click();
    const stopDialog = page.getByRole("dialog", { name: "Stop automatic scores", exact: true });
    await stopDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal((await loadBoardState(f.context)).personalEvaluation.modelEvaluation.automatic.approval.state, "enabled");
    await stop.click();
    const stopped = page.waitForResponse(response => response.url().endsWith("/api/evaluation/automatic/revoke"));
    await stopDialog.getByRole("button", { name: "Stop and remove scores", exact: true }).click();
    assert.equal((await stopped).status(), 200);
    await stopDialog.waitFor({ state: "hidden" });
    const state = await loadBoardState(f.context);
    assert.equal(state.personalEvaluation.consent.state, "off");
    assert.equal(state.personalEvaluation.modelEvaluation.automatic.approval.state, "revoked");
    assert.equal(state.personalEvaluation.modelEvaluation.records.length, 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("wire.automaticScore.pending")), null);
    await navigateSettings(page, "privacy");
    await saving.waitFor();
    assert.equal(await saving.isChecked(), false);
});

test("a lost approval reply is recovered by reading its original receipt after reload, never by submitting it again", { timeout: 45000 }, async t => {
    const f = await fixture(t), { page } = f;
    await page.route("**/api/evaluation/automatic/approve", async route => {
        await route.fetch();
        await route.abort("failed");
    });
    const dialog = await review(page);
    await dialog.getByRole("button", { name: "Approve automatic scores" }).click();
    await dialog.getByRole("button", { name: "Check approval result", exact: true }).waitFor();
    const receipt = await page.evaluate(() => sessionStorage.getItem("wire.automaticScore.pending"));
    assert.ok(receipt);
    await page.reload();
    await page.locator("#automaticScoreSetup").getByRole("button", { name: "Review automatic scores", exact: true }).click();
    const recovery = page.getByRole("dialog", { name: "Automatic scores", exact: true });
    await recovery.getByRole("button", { name: "Check approval result", exact: true }).click();
    await page.waitForFunction(() => sessionStorage.getItem("wire.automaticScore.pending") === null);
    assert.equal(f.routes.filter(route => route === "/api/evaluation/automatic/approve").length, 1);
    assert.equal((await loadBoardState(f.context)).personalEvaluation.modelEvaluation.automatic.receipts.filter(receipt => receipt.kind === "approve").length, 1);
});

test("local reply saving grants no scoring permission and its removal cannot erase independently approved model scores", { timeout: 45000 }, async t => {
    const f = await fixture(t), { page, runtime } = f;
    const saving = page.locator("#assessmentSetup").getByRole("checkbox");
    await navigateSettings(page, "privacy");
    await saving.check();
    const enabled = page.waitForResponse(response => response.url().endsWith("/api/assessment/consent/set"));
    await page.getByRole("button", { name: "Turn on response saving", exact: true }).click();
    assert.equal((await enabled).status(), 200);
    await page.waitForFunction(() => document.querySelector("#assessmentSetup input")?.checked && document.querySelector("#assessmentSetup button[type=submit]")?.hidden);
    for (const input of f.inputs) {
        const answer = input.events.find(event => event.type === "assistant.message"), timestamp = new Date().toISOString();
        const turnId = "saved-reply-" + input.record.scenarioId;
        await appendFile(path.join(f.config.sessionRoot, input.record.sourceSessionId, "events.jsonl"), [
            { id: "saved-final-" + input.record.scenarioId, type: "assistant.message", timestamp, data: { ...answer.data, turnId } },
            { id: "saved-turn-end-" + input.record.scenarioId, type: "assistant.turn_end", timestamp, data: { turnId } },
        ].map(event => JSON.stringify(event) + "\n").join(""));
    }
    await runtime.collector.collectNow();
    const captured = await loadBoardState(f.context);
    assert.equal(captured.personalEvaluation.captures.length, 2);
    assert.equal(f.calls.length, 0);
    const dialog = await review(page);
    const approved = page.waitForResponse(response => response.url().endsWith("/api/evaluation/automatic/approve"));
    await dialog.getByRole("button", { name: "Approve automatic scores", exact: true }).click();
    assert.equal((await approved).status(), 200);
    await dialog.waitFor({ state: "hidden" });
    await settle(f.context, 1);
    await runtime.collector.collectNow();
    await settle(f.context, 2);
    await navigateSettings(page, "privacy");
    await saving.uncheck();
    const removed = page.waitForResponse(response => response.url().endsWith("/api/assessment/consent/set"));
    await page.getByRole("button", { name: "Turn off and delete responses", exact: true }).click();
    assert.equal((await removed).status(), 200);
    const state = await loadBoardState(f.context);
    assert.equal(state.personalEvaluation.captures.length, 0);
    assert.equal(state.personalEvaluation.modelEvaluation.records.length, 2);
    assert.equal(state.personalEvaluation.modelEvaluation.automatic.approval.state, "enabled");
    assert.equal(f.calls.length, 2);
    await navigateMain(page, "home");
    const accuracy = page.locator('#homeInsights [data-dimension="accuracy"]').filter({ hasText: "Model assessment" });
    await accuracy.waitFor();
    assert.equal(await accuracy.locator(".assessment-value").innerText(), "50%");
});

for (const outcome of ["success", "error"]) for (const stage of ["confirmation", "pending", "confirmed"]) {
    test(`delayed setup ${outcome} cannot replace Stop ${stage}`, { timeout: 25000 }, async t => {
        const f = await fixture(t), { page, runtime } = f;
        await runtime.collector.setEnabled(false);
        const initial = await review(page);
        const approved = page.waitForResponse(response => response.url().endsWith("/api/evaluation/automatic/approve"));
        await initial.getByRole("button", { name: "Approve automatic scores", exact: true }).click();
        assert.equal((await approved).status(), 200);
        await initial.waitFor({ state: "hidden" });
        const settings = page.locator("#automaticScoreSetup");
        await settings.getByRole("button", { name: "Review automatic scores", exact: true }).waitFor();
        assert.equal((await loadBoardState(f.context)).personalEvaluation.modelEvaluation.automatic.approval.state, "enabled");
        assert.equal(f.calls.length, 0, "The race fixture never invokes a provider.");

        const setupRead = Promise.withResolvers(), releaseSetup = Promise.withResolvers();
        const stopRead = Promise.withResolvers(), releaseStop = Promise.withResolvers();
        await page.route("**/api/evaluation/automatic/setup", async route => {
            const response = await route.fetch();
            assert.equal(response.status(), 200);
            setupRead.resolve();
            await releaseSetup.promise;
            if (outcome === "success") await route.fulfill({ response });
            else await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic delayed setup failure" }) });
        });
        await page.route("**/api/evaluation/automatic/revoke", async route => {
            const response = await route.fetch();
            assert.equal(response.status(), 200);
            stopRead.resolve();
            await releaseStop.promise;
            await route.fulfill({ response });
        });
        try {
            await settings.getByRole("button", { name: "Review automatic scores", exact: true }).click();
            await setupRead.promise;
            const loading = page.getByRole("dialog", { name: "Automatic scores", exact: true });
            assert.match(await loading.innerText(), /Reading the approved source/);
            await loading.getByRole("button", { name: "Close", exact: true }).click();
            await settings.getByRole("button", { name: "Stop automatic scores", exact: true }).click();
            const stopDialog = page.getByRole("dialog", { name: "Stop automatic scores", exact: true });
            await stopDialog.waitFor();

            if (stage !== "confirmation") {
                await stopDialog.getByRole("button", { name: "Stop and remove scores", exact: true }).click();
                await stopRead.promise;
                assert.match(await stopDialog.innerText(), /Stopping and waiting for owned cleanup/);
            }
            if (stage === "confirmed") {
                releaseStop.resolve();
                await stopDialog.waitFor({ state: "hidden" });
            }
            const before = await page.locator(".automatic-score-dialog").innerHTML();
            const setupResponse = page.waitForResponse(response => response.url().endsWith("/api/evaluation/automatic/setup"));
            releaseSetup.resolve();
            await (await setupResponse).finished();
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

            assert.equal(await page.locator(".automatic-score-chats").count(), 0, "A stale setup response must not mount approval controls over Stop.");
            assert.equal(await page.locator(".automatic-score-dialog").innerHTML(), before, "Neither a late success nor error owns the replacement dialog.");
            if (stage === "confirmed") assert.equal(await page.locator(".automatic-score-dialog").isVisible(), false, "A completed Stop must not be reopened.");
            else {
                assert.equal(await stopDialog.isVisible(), true);
                assert.equal(await stopDialog.getByRole("button", { name: "Stop and remove scores", exact: true }).isEnabled(), stage === "confirmation");
                if (stage === "pending") {
                    releaseStop.resolve();
                    await stopDialog.waitFor({ state: "hidden" });
                }
            }
            assert.equal(f.routes.filter(route => route === "/api/evaluation/automatic/approve").length, 1);
            assert.equal(f.routes.filter(route => route === "/api/evaluation/automatic/revoke").length, stage === "confirmation" ? 0 : 1);
            assert.equal(f.calls.length, 0);
        } finally {
            releaseSetup.resolve(); releaseStop.resolve();
            await page.unrouteAll({ behavior: "wait" });
        }
    });
}
