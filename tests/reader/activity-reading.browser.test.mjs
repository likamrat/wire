import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { loadBoardState } from "../../lib/store.mjs";
import { recordedResponseTiming } from "../../lib/response-timing.mjs";
import { recordedInteractionModels } from "../../lib/interaction-model.mjs";
import { promptRecord } from "../../lib/prompt-authorship.mjs";
import { fixture, privateFixture } from "../support/helpers.mjs";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
test("activity card and reader form one exact, private reading and return journey", { timeout: 45000 }, async t => {
    const record = fixture("reading-overhaul");
    record.sourceSessionName = "Quarterly research review";
    record.projectId = null; record.project = null;
    record.followUpPrompts = [];
    const promptEvent = { id: "reading-prompt", type: "user.message", timestamp: "2026-10-12T12:40:00.000Z",
        data: { messageId: "p", source: "user", content: "Review the slide deck I created for the research review when I joined the project" } };
    record.userPrompt = promptRecord(promptEvent);
    record.toolCalls = [{ tool: "workiq-ask", toolCallId: "reading-ask", startEventId: "reading-start",
        requestArgs: { question: record.userPrompt.text }, startedAt: "2026-10-12T12:40:10.000Z",
        completedAt: "2026-10-12T12:41:34.892Z", durationMs: 84892, toolSucceeded: true,
        reportedOutcome: "succeeded", apiResults: [], observedGraphHttp: false }];
    const events = [
        promptEvent,
        { id: "reading-response", type: "assistant.message", timestamp: "2026-10-12T12:41:54.090Z",
            data: { wireResponseMetadataVersion: 1, finalAnswer: true, hasResponseText: true, hasToolRequests: false, turnId: "t", originatingMessageId: "p", model: "recorded-model" } },
        { id: "reading-end", type: "assistant.turn_end", timestamp: "2026-10-12T12:41:54.091Z", data: { turnId: "t" } },
    ];
    record.responseTiming = recordedResponseTiming(events, record.userPrompt);
    record.originalModelEvidence = recordedInteractionModels(events, record);
    const cleanup = [], { context } = await privateFixture({ after: action => cleanup.push(action) }, [record]);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: async () => { throw Error("No provider in reading proof"); },
            readSource: async () => { throw Error("No source scan in reading proof"); } } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", timezoneId: "UTC" });
    const errors = [], denied = [];
    let snapshot;
    page.on("response", async response => {
        if (response.ok() && response.url().endsWith("/api/snapshot")) snapshot = await response.json();
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET"
            || ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail", "/api/evaluation/automatic/summary"].includes(url.pathname))) return route.continue();
        denied.push(url.pathname); return route.abort();
    });
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        async writeText(text) { (window.readingCopies ??= []).push(text); },
        readText() { throw Error("No OS clipboard access"); },
    } }));
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url); await ready(page);
    const card = page.locator(`#activityList [data-view-key="request:${record.scenarioId}"]`);
    await expect(card).toContainText(record.userPrompt.text);
    const open = card.locator(".request-card-open");
    await open.press("Enter");
    const call = page.locator('[data-tool-call-id="reading-ask"]');
    await expect(call.locator(".reader-call-duration data")).toHaveAttribute("value", "84892");
    await expect(page.locator("#requestContent .response-timing data")).toHaveAttribute("value", "114090");
    assert.equal(snapshot.analytics.rows[0].workload, "Unknown");
    await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
    assert.equal(await page.evaluate(() => window.readingCopies.at(-1)), record.userPrompt.text);
    await page.goBack(); await expect(open).toBeFocused();
});
