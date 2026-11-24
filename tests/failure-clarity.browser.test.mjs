import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture } from "./helpers.mjs";

const cases = [
    ["unsaved", "text-excluded", null, "WIRE did not save the error details"],
    ["path", "text-excluded", "mcp-server-path-not-found", "Work IQ could not find the requested tool server"],
    ["signin", "text-excluded", "workiq-sign-in-required", "Work IQ required sign-in at the time"],
    ["absent", "not-supplied", null, "The tool did not provide an error reason"],
    ["privacy", "sensitive-excluded", null, "Error details omitted for privacy"],
    ["limit", "size-excluded", null, "Error details were too long to save"],
    ["format", "unsupported-format", null, "WIRE could not extract a readable reason from the recorded error"],
    ["legacy", "unqualified", null, "Failure reason unavailable"],
];

function record([id, status, signal]) {
    const value = fixture("failure-" + id);
    value.sourceSessionId = "invented-session-" + id;
    value.sourceSessionName = "Planning review";
    value.userPrompt = { text: `Check the planning feature (${id}).`, status: "full",
        sourceEventId: "invented-prompt-" + id, sourceTimestamp: "2026-10-01T12:00:00.000Z",
        authorship: { actor: "user", basis: "source-user" } };
    value.followUpPrompts = [];
    const count = id === "unsaved" ? 6 : 1;
    value.toolCalls = Array.from({ length: count }, (_, index) => {
        const failed = count === 1 || index >= 4;
        const startedAt = `2026-10-01T12:0${index}:01.000Z`;
        const durationMs = [11000, 7000, 325, 28000, 600, 1100][index];
        return {
            tool: id === "signin" ? "workiq-retrieve" : failed ? "workiq-get_schema" : "workiq-search_paths",
            toolCallId: `invented-${id}-${index + 1}`, startEventId: `invented-start-${id}-${index + 1}`,
            completionEventId: `invented-end-${id}-${index + 1}`, startedAt, durationMs,
            completedAt: new Date(Date.parse(startedAt) + durationMs).toISOString(),
            toolSucceeded: !failed, reportedOutcome: failed ? "failed" : "succeeded",
            requestArgs: id === "signin" ? { query: "Planning notes", capabilities: [{ name: "Email" }] }
                : failed ? { path: "/invented/planning", operationType: "fetch", format: "typescript" }
                    : { query: "planning feature" },
            apiResults: [], observedGraphHttp: false,
            ...(failed ? { failureEvidence: { version: 1, reason: "error-code-recorded", code: "failure",
                messageStatus: status, messageSignal: signal,
                ...(signal === "mcp-server-path-not-found" ? { messageSource: "workiq-error-json" } : {}) } } : {}),
        };
    });
    return value;
}

test("the reader keeps eight recorded failure reasons distinct without inventing a repair action", { timeout: 60000 }, async t => {
    const cleanup = [], errors = [], unexpected = [];
    const records = cases.map(record);
    const unverifiedPath = record(["unverified-path", "text-excluded", "mcp-server-path-not-found"]);
    delete unverifiedPath.toolCalls[0].failureEvidence.messageSource;
    const unverifiedSignIn = record(["unverified-signin", "sensitive-excluded", "workiq-sign-in-required"]);
    const unqualified = record(["unqualified", "unqualified", null]);
    delete unqualified.toolCalls[0].failureEvidence;
    unqualified.toolCalls[0].requestArgs = { path: "/invented/sign-in" };
    unqualified.toolCalls[0].apiResults = [{ statusCode: 401 }];
    records.push(unverifiedPath, unverifiedSignIn, unqualified, record(["timeout", "text-excluded", "request-timeout"]));
    const { context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(3000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET"
            || ["/api/snapshot", "/api/connect", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview"].includes(url.pathname))) return route.continue();
        unexpected.push(url.pathname); return route.abort();
    });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(await loadBoardState(context), before);
            assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
        } finally { for (const fn of cleanup) await fn(); }
    });
    for (const [id,,,label] of cases) {
        await page.goto(runtime.url + "#request?" + new URLSearchParams({request:`failure-${id}`}));
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        const call = page.locator(`[data-tool-call-id="invented-${id}-${id === "unsaved" ? 5 : 1}"]`);
        const toggle = call.locator(".reader-call-toggle");
        if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
        await expect(call.locator(".reader-call-summary")).toContainText("1 tool call failed");
        await expect(call).toContainText(label);
        await expect(call.getByRole("button",{name:/sign in|reconnect|retry/i})).toHaveCount(0);
    }
    for (const [id, forbidden] of [["unverified-path", /could not find the requested tool server/i],
        ["unverified-signin", /Work IQ required sign-in at the time/i], ["unqualified", /Work IQ required sign-in at the time/i]]) {
        await page.goto(runtime.url + "#request?" + new URLSearchParams({request:`failure-${id}`}));
        const row = page.locator(`[data-tool-call-id="invented-${id}-1"]`);
        await expect(row.locator(".reader-call-summary")).toContainText("1 tool call failed");
        const toggle = row.locator(".reader-call-toggle");
        if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
        await expect(row).not.toContainText(forbidden);
    }
});

test("current reader keeps succeeded, partial and unknown results with their call ordinals", { timeout: 15000 }, async t => {
    const value = fixture("reader-owned-outcomes"), original = value.toolCalls[0];
    value.userPrompt = { text: "Check the planning notes.", status: "full",
        sourceEventId: "invented-outcome-prompt", sourceTimestamp: "2026-10-01T12:00:00.000Z",
        authorship: { actor: "user", basis: "source-user" } };
    value.followUpPrompts = [];
    value.toolCalls = ["succeeded", "partial", "unknown"].map((reportedOutcome, index) => ({
        ...original, tool: "workiq-ask", toolCallId: `invented-outcome-${index + 1}`,
        startEventId: `invented-outcome-start-${index + 1}`,
        startedAt: `2026-10-01T12:0${index}:01.000Z`,
        reportedOutcome, toolSucceeded: reportedOutcome === "succeeded" ? true : null,
        requestArgs: { question: "Check the planning notes." }, apiResults: [],
    }));
    const cleanup = [], errors = [], unexpected = [];
    const { context } = await privateFixture({ after: fn => cleanup.push(fn) }, [value]);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(), page = await browser.newPage({ reducedMotion: "reduce" });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET"
            || ["/api/snapshot", "/api/connect", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview"].includes(url.pathname))) return route.continue();
        unexpected.push(url.pathname); return route.abort();
    });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(await loadBoardState(context), before);
            assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
        } finally { for (const fn of cleanup) await fn(); }
    });
    await page.goto(runtime.url);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.locator(".request-card-open").click();
    const calls = page.locator("#requestContent .reader-call-row");
    await expect(calls).toHaveCount(3);
    await expect(calls.nth(0).getByRole("group", { name: "Tool completion: 1 Work IQ tool call", exact: true })).toHaveText("1 tool call completed");
    await expect(calls.nth(1).locator(".reader-call-summary")).toContainText("partly completed");
    await expect(calls.nth(2).locator(".reader-call-summary")).toContainText("has no recorded result");
    for (const [index, outcome] of ["success", "partial", "unknown"].entries()) {
        await expect(calls.nth(index).locator("[data-outcome]")).toHaveAttribute("data-outcome", outcome);
        await expect(calls.nth(index).locator(".reader-entry-label")).toHaveText(`Call #${index + 1}`);
    }
    await expect(calls.nth(1).locator(".result-cause")).toContainText("That flag alone does not say which part completed.");
    await expect(calls.nth(0).locator(".result-cause")).toHaveCount(0);
    await expect(calls.nth(2).locator(".result-cause")).toHaveCount(0);
    await expect(calls.locator(".reader-failure-guidance")).toHaveCount(0);
});
