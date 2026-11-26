import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { loadBoardState } from "../../lib/store.mjs";
import { recordedInteractionModels } from "../../lib/interaction-model.mjs";
import { fixture, privateFixture, chooseTheme } from "../support/helpers.mjs";

function clarityRecord() {
    const record = fixture("clarity-sign-in");
    record.sourceSessionName = "Invented workshop preparation";
    record.userPrompt = {
        text: "Find the workshop agenda and list the unresolved decisions.",
        status: "full", sourceEventId: "clarity-prompt", sourceTimestamp: "2026-10-01T12:00:00Z",
        authorship: { actor: "user", basis: "source-user" },
    };
    record.followUpPrompts = [];
    record.toolCalls = [{
        tool: "workiq-retrieve", toolCallId: "clarity-call", startEventId: "clarity-start",
        startedAt: "2026-10-01T12:00:01Z", durationMs: 252,
        toolSucceeded: false, reportedOutcome: "failed", apiResults: [],
        requestArgs: { query: "Invented workshop agenda" },
        failureEvidence: { version: 1, reason: "error-code-recorded", code: "failure",
            messageStatus: "text-excluded", messageSignal: "workiq-sign-in-required" },
    }];
    const events = [
        { id: "clarity-prompt", type: "user.message", timestamp: record.userPrompt.sourceTimestamp,
            data: { messageId: "clarity-message" } },
        { id: "clarity-response", type: "assistant.message", timestamp: "2026-10-01T12:00:02Z",
            data: { originatingMessageId: "clarity-message", model: "recorded-model", turnId: "clarity-turn" } },
    ];
    record.originalModelEvidence = recordedInteractionModels(events, record);
    return record;
}

async function setup(t, record = clarityRecord()) {
    const cleanup = [];
    const { context } = await privateFixture({ after: fn => cleanup.push(fn) }, Array.isArray(record) ? record : [record]);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [], blocked = [];
    page.setDefaultTimeout(3000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET"
            || ["/api/snapshot", "/api/connect", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview"].includes(url.pathname))) return route.continue();
        blocked.push(url.pathname);
        return route.abort();
    });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []);
            assert.deepEqual(blocked, []);
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation", "pseudonymKey"]) assert.deepEqual(after[key], before[key]);
        } finally { for (const fn of cleanup) await fn(); }
    });
    await page.goto(runtime.url);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    return { page, record, runtime };
}

test("a recorded failure explains its cause with the outcome from card to reader", async t => {
    const { page } = await setup(t);
    const card = page.locator(".request-card-open");
    await expect(card).toHaveText("1 tool call failed");
    await expect(card).not.toContainText("Work IQ required sign-in at the time");
    await card.click();
    const call = page.locator('.journey-item[data-tool-call-id="clarity-call"]');
    await expect(call.locator(".call-heading")).toContainText("Work IQ required sign-in at the time");
    await expect(call.locator(".card-outcome-label")).toHaveText("1 tool call failed");
    await expect(call.locator(".reader-recorded-signal")).toHaveCount(0);
    assert.equal((await call.innerText()).match(/Work IQ required sign-in at the time/g)?.length, 1);
    await expect(call.locator(".reader-call-duration data")).toHaveAttribute("value", "252");
});

test("model identity is separate from an explained incomplete recording", async t => {
    const { page } = await setup(t);
    await page.locator(".request-card-open").click();
    await expect(page.locator(".interaction-model-fact .model-identity")).toHaveText("recorded-model");
    await expect(page.locator(".model-recording-note")).toContainText("final response");
    await expect(page.locator(".model-identity")).not.toContainText("(partial record)");
});

test("model recording reasons compose one qualified statement without losing any retained reason", async t => {
    const cases = [
        { name: "boundary-truncated", reasons: ["unverified-final-boundary", "truncated-history"],
            expected: "Model history is incomplete: the final response boundary was not verified; a source window or retention limit cut it short." },
        { name: "all-three", reasons: ["missing-response-models", "unverified-final-boundary", "truncated-history"],
            expected: "Model history is incomplete: some responses have no linked model name; the final response boundary was not verified; a source window or retention limit cut it short." },
        { name: "missing", reasons: ["missing-response-models"],
            expected: "Some responses have no linked model name." },
        { name: "boundary", reasons: ["unverified-final-boundary"],
            expected: "Model history may be incomplete: the final response boundary was not verified." },
        { name: "truncated", reasons: ["truncated-history"],
            expected: "Model history is incomplete: a source window or retention limit cut it short." },
    ];
    const records = cases.map(({ name, reasons }) => {
        const record = clarityRecord();
        record.scenarioId = `model-note-${name}`;
        record.sourceSessionId = `model-note-session-${name}`;
        Object.assign(record.originalModelEvidence, {
            sourceSessionId: record.sourceSessionId, partial: reasons.includes("unverified-final-boundary"),
            truncated: reasons.includes("truncated-history"), unlinked: reasons.includes("missing-response-models"),
        });
        return record;
    });
    const { page } = await setup(t, records), proof = process.env.WIRE_MODEL_NOTE_PROOFS, observations = [];
    if (proof) await mkdir(proof, { recursive: true });
    for (const { name, expected, reasons } of cases) {
        await page.locator(`.request-row[data-view-key="request:model-note-${name}"] .request-card-open`).click();
        const note = page.locator("#requestContent .model-recording-note");
        await expect(note).toHaveCount(1);
        await expect(note).toHaveText(expected);
        await expect(page.locator("#requestContent .model-identity")).toHaveText("recorded-model");
        const source = page.getByRole("button", { name: "Source details" });
        if (await source.getAttribute("aria-expanded") === "false") await source.click();
        assert.ok(((await note.textContent()).match(/Model history/g) ?? []).length <= 1);
        if (reasons.length > 1) for (const theme of ["light", "dark"]) {
            await page.setViewportSize({ width: 1440, height: 1000 });
            await page.evaluate(() => document.documentElement.style.fontSize = "100%");
            await chooseTheme(page, theme);
            for (const [width, scale] of [[1440, 1], [375, 2]]) {
                await page.setViewportSize({ width, height: 1000 });
                await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
                await page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
                await page.locator("#requestContent .interaction-model-fact").scrollIntoViewIfNeeded();
                const geometry = await note.evaluate(node => ({
                    width: node.getBoundingClientRect().width,
                    rowWidth: node.parentElement.getBoundingClientRect().width,
                    overflow: node.scrollWidth - node.clientWidth,
                    weight: getComputedStyle(node).fontWeight,
                    text: node.textContent,
                }));
                assert.ok(geometry.width > 0 && geometry.width >= geometry.rowWidth - 1);
                assert.ok(geometry.overflow <= 1);
                assert.equal(geometry.weight, "400");
                assert.equal(geometry.text, expected);
                assert.ok(await page.locator("#contextSidebarBody").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
                assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
                observations.push({ name, theme, viewportWidth: width, textScale: scale, ...geometry });
                if (proof) await page.screenshot({ path: path.join(proof, `${name}-${theme}-${width}-${scale}.png`) });
            }
        }
        await page.locator("#closeContextSidebar").click();
        await page.waitForFunction(() => !document.querySelector("#contextSidebar").open);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => document.documentElement.style.fontSize = "100%");
    }
    if (proof) await writeFile(path.join(proof, "combined-note-proof.json"), JSON.stringify(observations, null, 2));
});

test("returned entries retain their individual results independently of their failed parent", async t => {
    const record = clarityRecord();
    record.toolCalls[0].apiResults = [
        { index: 7, errorCode: "MailboxUnavailable", statusCode: 503 },
        { index: 7, errorCode: "InvalidQuery", statusCode: null },
        { index: 8, statusCode: 200 }];
    const { page, runtime } = await setup(t, record);
    await page.goto(runtime.url + "#request?request=" + record.scenarioId);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.locator('[data-tool-call-id="clarity-call"] .reader-call-toggle').click();
    const calls = page.locator(".api-result-entry");
    await expect(calls).toHaveCount(3);
    await expect(calls.nth(0)).toContainText("Tool-reported HTTP 503: MailboxUnavailable");
    await expect(calls.nth(1)).toContainText("InvalidQuery");
    await expect(calls.nth(2)).toContainText("200");
    await expect(page.locator('[data-tool-call-id="clarity-call"] .call-heading .card-outcome-label')).toHaveText("1 tool call failed");
    await expect(calls.locator(".result-cause")).toHaveCount(0);
    for (const call of await calls.all()) await expect(call).not.toContainText(/sign-in/i);
});
