import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";

const cases = [
    ["unsaved", "text-excluded", null, "WIRE did not save the error details"],
    ["path", "text-excluded", "mcp-server-path-not-found", "Work IQ could not find the requested address"],
    ["signin", "text-excluded", "workiq-sign-in-required", "Work IQ required sign-in at the time"],
    ["absent", "not-supplied", null, "The tool did not provide an error reason"],
    ["privacy", "sensitive-excluded", null, "Error details omitted for privacy"],
    ["limit", "size-excluded", null, "Error details were too long to save"],
    ["format", "unsupported-format", null, "WIRE could not read the error details"],
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

test("failure cards and reader explain eight states without invented causes or repair controls", { timeout: 60000 }, async t => {
    const cleanup = [], errors = [], unexpected = [], observations = [];
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
    const proof = process.env.WIRE_FAILURE_PROOFS;
    if (proof) await mkdir(proof, { recursive: true });
    await page.goto(runtime.url);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    for (const [theme, width, scale] of [["light", 1440, 100], ["light", 390, 200], ["dark", 390, 200]]) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => document.documentElement.style.fontSize = "100%");
    await chooseTheme(page, theme);
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(scale => document.documentElement.style.fontSize = `${scale}%`, scale);
    for (const [id, , , expected] of cases) {
        const card = page.locator(".request-card-open").filter({ hasText: `Check the planning feature (${id}).` });
        await expect(card).toContainText(expected);
        if (id === "unsaved") {
            await expect(card).toContainText("2 of 6 recorded calls failed.");
            await expect(card).toContainText("6 recorded calls / 4 worked / 2 failed");
        }
        await card.click();
        const call = page.locator(`[data-tool-call-id="invented-${id}-${id === "unsaved" ? 5 : 1}"]`);
        await expect(call.locator(".reader-call-summary")).toContainText(expected);
        await expect(call.locator(".recorded-result-label")).toHaveText(`Call ${id === "unsaved" ? 5 : 1} failed`);
        if (await call.locator(".reader-call-toggle").getAttribute("aria-expanded") !== "true") await call.locator(".reader-call-toggle").click();
        const guidance = call.locator(".reader-failure-guidance");
        await expect(guidance).not.toBeEmpty();
        assert.ok((await guidance.innerText()).split(/\s+/).length <= 27);
        assert.doesNotMatch(await guidance.innerText(), /\bMCP\b|search_paths|get_schema|unqualified|metadata|HTTP|credential|Refresh/i);
        await expect(guidance.locator("a,button")).toHaveCount(0);
        if (id === "signin") await expect(guidance).toContainText("If a new attempt also asks you to sign in");
        else await expect(call.locator(".reader-call-evidence")).toHaveText("This checks how to use a Work IQ feature; it does not run it.");
        if (id === "legacy") await expect(guidance).toContainText("The saved record does not explain why this call failed.");
        assert.ok(await page.locator("#contextSidebarBody").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
        await guidance.scrollIntoViewIfNeeded();
        observations.push({ id, theme, width, scale, heading: await call.locator(".call-heading").innerText(), guidance: await guidance.innerText() });
        if (proof) await page.locator("#contextSidebar").screenshot({ path: path.join(proof, `${theme}-${width}-${scale}-${id}-reader.png`) });
        await page.locator("#closeContextSidebar").click();
        await page.waitForFunction(() => !document.querySelector("#contextSidebar").open);
    }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => document.documentElement.style.fontSize = "100%");
    for (const id of ["unverified-path", "unverified-signin", "unqualified", "timeout"]) {
        await page.goto(runtime.url + "#request?" + new URLSearchParams({ request: "failure-" + id, origin: "analyze" }));
        await page.locator('#workspace[aria-busy="false"]').waitFor();
        const call = page.locator(`[data-tool-call-id="invented-${id}-1"]`);
        if (await call.locator(".reader-call-toggle").getAttribute("aria-expanded") !== "true") await call.locator(".reader-call-toggle").click();
        const guidance = await call.locator(".reader-failure-guidance").innerText();
        if (id === "timeout") {
            await expect(call.locator(".result-cause")).toHaveText("The tool did not respond in time");
            assert.match(guidance, /before trying again/);
            assert.match(guidance, /does not show whether the work finished/);
        } else {
            assert.doesNotMatch(guidance, /sign in|available Work IQ|try again|retry/i);
            await expect(call.locator(".result-cause")).not.toContainText("Work IQ required sign-in");
            await expect(call.locator(".result-cause")).not.toContainText("requested address");
        }
        await page.locator("#closeContextSidebar").click();
        await page.waitForFunction(() => !document.querySelector("#contextSidebar").open);
    }
    await page.evaluate(() => {
        window.copied = [];
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => window.copied.push(value) } });
    });
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 100], [768, 100], [390, 200]]) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => document.documentElement.style.fontSize = "100%");
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale}%`, scale);
        const card = page.locator(".request-card-open").filter({ hasText: "Check the planning feature (unsaved)." });
        await card.click();
        const fourth = page.locator('[data-tool-call-id="invented-unsaved-4"]');
        const fifth = page.locator('[data-tool-call-id="invented-unsaved-5"]');
        const sixth = page.locator('[data-tool-call-id="invented-unsaved-6"]');
        for (const call of [fifth, sixth]) if (await call.locator(".reader-call-toggle").getAttribute("aria-expanded") !== "true") await call.locator(".reader-call-toggle").click();
        await expect(page.locator("#requestContent [data-outcome=success]")).toHaveCount(4);
        await expect(page.locator("#requestContent [data-outcome=failure]")).toHaveCount(2);
        await expect(fifth.locator("data.call-duration")).toHaveAttribute("value", "600");
        await expect(sixth.locator("data.call-duration")).toHaveAttribute("value", "1100");
        await expect(fourth.locator(".reader-call-summary .reader-entry-label")).toHaveText("Call 4");
        const geometry = await fourth.evaluate(row => {
            const scroll = document.querySelector("#contextSidebarBody");
            const heading = document.querySelector('[data-reader-section="activity"] > .reader-section-heading');
            const summary = row.querySelector(".reader-call-summary");
            scroll.scrollTop += summary.getBoundingClientRect().top - scroll.getBoundingClientRect().top - heading.getBoundingClientRect().height - 2;
            const owner = summary.querySelector(".reader-entry-label");
            return { titleBottom: heading.getBoundingClientRect().bottom, ownerTop: owner.getBoundingClientRect().top,
                ownerBottom: owner.getBoundingClientRect().bottom, text: summary.textContent.trim() };
        });
        assert.ok(geometry.ownerTop >= geometry.titleBottom - 1, JSON.stringify(geometry));
        assert.equal(geometry.text, "Call 4 succeeded");
        assert.ok(await page.locator("#contextSidebarBody").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        if (proof) await page.locator("#contextSidebar").screenshot({ path: path.join(proof, `${theme}-${width}-${scale}-scroll.png`) });
        const copy = fifth.getByRole("button", { name: "Copy recorded arguments", exact: true });
        await copy.click();
        assert.equal((await page.evaluate(() => window.copied)).at(-1), JSON.stringify(records[0].toolCalls[4].requestArgs, null, 2));
        await fifth.locator(".reader-call-toggle").focus();
        await page.keyboard.press("Enter");
        await expect(fifth.locator(".reader-call-toggle")).toBeFocused();
        await expect(fifth.locator(".technical-detail")).toBeHidden();
        await page.keyboard.press("Enter");
        await expect(fifth.locator(".reader-call-toggle")).toBeFocused();
        await page.evaluate(() => {
            const text = document.querySelector('[data-tool-call-id="invented-unsaved-5"] .reader-failure-guidance');
            window.oldPrivate = document.querySelector("#requestContent .full-text-content");
            window.oldInput = document.querySelector('[data-tool-call-id="invented-unsaved-5"] .recorded-arguments');
            window.oldCopy = window.oldInput.querySelector("button");
            const range = document.createRange(); range.selectNodeContents(text);
            getSelection().removeAllRanges(); getSelection().addRange(range);
        });
        assert.match(await page.evaluate(() => getSelection().toString()), /original Copilot chat/);
        await page.locator("#closeContextSidebar").click();
        await page.waitForFunction(() => !document.querySelector("#contextSidebar").open);
        assert.equal(await page.evaluate(() => window.oldPrivate.textContent), "");
        assert.equal(await page.evaluate(() => window.oldInput.isConnected), false);
        const copies = await page.evaluate(() => window.copied.length);
        await page.evaluate(() => window.oldCopy.click());
        assert.equal(await page.evaluate(() => window.copied.length), copies);
    }
    if (proof) await writeFile(path.join(proof, "wording.json"), JSON.stringify(observations, null, 2));
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
    await expect(calls.locator(".recorded-result-label")).toHaveText([
        "Call 1 succeeded", "Call 2 partly succeeded", "Call 3 has no recorded result",
    ]);
    for (const [index, outcome] of ["success", "partial", "unknown"].entries()) {
        await expect(calls.nth(index).locator("[data-outcome]")).toHaveAttribute("data-outcome", outcome);
        await expect(calls.nth(index).locator(".reader-call-summary .reader-entry-label")).toHaveText(`Call ${index + 1}`);
    }
    await expect(calls.locator(".result-cause,.reader-failure-guidance")).toHaveCount(0);
});
