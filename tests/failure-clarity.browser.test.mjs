import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { fixture, privateFixture, chooseTheme, automaticScoreOffSummary, revealStoredRefresh } from "./helpers.mjs";
import { evaluationFixture, assessed, materializeEvaluationSource } from "./evaluation-fixture.mjs";
import { completeWorkIqCall } from "../lib/history.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";

test("a recorded sign-in failure explains execution and unassessed quality together without blaming global scoring or retrying", async t => {
    const record = fixture("sign-in-context");
    Object.assign(record.toolCalls[0], { toolSucceeded: false, reportedOutcome: "failed", apiResults: [],
        requestArgs: { entityUrls: ["/me?$select=creationType"] }, requestedApiPath: "/me",
        failureEvidence: { version: 1, reason: "error-code-recorded", code: "failure",
            messageStatus: "text-excluded", messageSignal: "workiq-sign-in-required" } });
    const { context } = await privateFixture(t, [record]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 950 } });
    t.after(async () => { await browser.close(); await runtime.close(); });
    const paused = automaticScoreOffSummary();
    Object.assign(paused.snapshot, { state: "paused", reason: "unknown-billing" });
    Object.assign(paused.snapshot.usage, { costUnknown: true, callsReserved: 1 });
    await page.route("**/api/evaluation/automatic/summary", route => route.fulfill({ json: paused }));
    const writes = [];
    page.on("request", request => {
        if (/\/api\/(?:evaluation\/(?:start|automatic\/approve)|assessment\/(?:feedback|consent\/set)|collection\/(?:configure|now))$/.test(new URL(request.url()).pathname)) writes.push(request.url());
    });
    await page.goto(runtime.url + "#request?request=sign-in-context&range=capture");
    const insights = page.locator(".interaction-insights");
    await insights.locator(".assessment-grid").waitFor();
    const connected = insights.locator("[data-review-status]");
    assert.equal(await connected.count(), 1, "The failure cause and per-attempt quality state must be connected near Insights.");
    const text = await connected.innerText();
    assert.match(text, /Work IQ sign-in was required/);
    assert.match(text, /No AI quality assessment is recorded for this attempt/);
    assert.match(text, /Copilot.*\/mcp auth workiq/);
    assert.doesNotMatch(text, /HTTP 401|HTTP 403|unknown.*charge|unknown.*billing|local-source settings/i);
    assert.equal(await insights.locator(".assessment-scoring-status").count(), 0);
    assert.equal(await insights.getByRole("button", { name: "Automatic scores", exact: true }).count(), 1);
    assert.equal(await connected.getByRole("button").count(), 0, "Historical failure help is not a retry or authentication bridge.");
    assert.match(await page.locator(".request-outcome").innerText(), /Work IQ sign-in was required/);
    assert.deepEqual(writes, []);
    for (const [theme, width, scale] of [["light", 1200, 1], ["dark", 375, 1], ["light", 375, 2]]) {
        await page.setViewportSize({ width, height: 1100 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        assert.equal(await connected.isVisible(), true);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${theme}/${width}/${scale}`);
        assert.ok(await connected.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    }
});

test("connected request summaries keep operational failures, recovery and quality evaluator states distinct", async t => {
    for (const kind of ["unknown-cause", "success-unassessed", "recovered", "evaluator-error", "insufficient", "same-endpoint"]) {
        await t.test(kind, async t => {
            const f = await evaluationFixture(t, request => {
                if (kind === "evaluator-error") throw new Error("PRIVATE_EVALUATOR_ERROR");
                const result = assessed(request, false);
                if (kind === "insufficient") for (const item of [...result.rawResult.requirements, ...result.rawResult.answerSegments, ...result.rawResult.actions]) {
                    item.verdict = "insufficient"; item.reason = "missing-evidence";
                }
                return result;
            });
            for (const input of f.inputs) {
                input.record.toolCalls[0].requestArgs = { entityUrls: ["/me?$select=creationType"] };
                input.record.toolCalls[0].requestedApiPath = "/me";
                input.events[2].data.arguments = input.record.toolCalls[0].requestArgs;
                input.events[4].data.content = "Three synthetic items.";
            }
            const first = f.inputs[0], original = structuredClone(first.record.toolCalls[0]), originalEnd = structuredClone(first.events[3]);
            if (["unknown-cause", "recovered", "same-endpoint"].includes(kind)) {
                first.events[3].data = { toolCallId: original.toolCallId, success: false,
                    ...(kind === "unknown-cause" ? {} : { error: { code: "failure",
                        message: 'Re-authentication required for MCP server "workiq". Run /mcp auth workiq' } }) };
                first.record.toolCalls[0] = completeWorkIqCall(original, first.events[3]);
                if (kind === "unknown-cause") delete first.record.toolCalls[0].failureEvidence;
            }
            if (kind === "recovered") {
                const start = { ...structuredClone(first.events[2]), id: "retry-start", data: { ...first.events[2].data, toolCallId: "retry-call" } };
                const end = { ...originalEnd, id: "retry-end", data: { ...originalEnd.data, toolCallId: "retry-call" } };
                first.events.splice(4, 0, start, end);
                first.record.toolCalls.push(completeWorkIqCall({ ...original, toolCallId: "retry-call", startEventId: start.id }, end));
            }
            const old = await loadBoardState(f.context);
            await replaceEvidence(f.context, () => ({ records: f.inputs.map(input => input.record), importCoverage: old.importCoverage }));
            await materializeEvaluationSource(f);
            f.input.expectedSourceRevision = (await loadBoardState(f.context)).evidenceRevision;
            f.input.scenarioIds = [f.inputs[kind === "same-endpoint" ? 1 : 0].record.scenarioId]; f.input.maxAiCredits = 30;
            if (!["unknown-cause", "success-unassessed"].includes(kind)) {
                await f.controller.start("fixture", f.input); await f.controller.settle();
            }
            const before = await loadBoardState(f.context), beforeCalls = f.calls.length;
            const runtime = await startServer(f.context, createExportController(f.context), {
                port: 0, collector: { timers: false }, evaluation: { evaluatorFactory: f.options.evaluatorFactory },
            });
            const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 950 } });
            t.after(async () => { await browser.close(); await runtime.close(); });
            const pageErrors = [], writes = [];
            page.on("pageerror", error => pageErrors.push(error.message));
            page.on("request", request => {
                if (/\/api\/(?:evaluation\/(?:start|automatic\/approve)|assessment\/(?:feedback|consent\/set)|collection\/(?:configure|now))$/.test(new URL(request.url()).pathname)) writes.push(request.url());
            });
            async function readRequest(id) {
                await page.goto(runtime.url + "#request?request=" + id + "&range=capture");
                await page.locator(".interaction-insights .assessment-grid").waitFor();
                return page.locator(".interaction-insights [data-review-status]").innerText();
            }
            const text = await readRequest(first.record.scenarioId);
            if (kind === "unknown-cause") {
                assert.match(text, /Cause unavailable in retained evidence/);
                assert.match(text, /No AI quality assessment is recorded/);
            } else if (kind === "success-unassessed") {
                assert.match(text, /recorded Work IQ call completed/);
                assert.match(text, /No AI quality assessment is recorded/);
                assert.doesNotMatch(text, /call failed|sign-in was required/);
            } else if (kind === "recovered") {
                assert.match(text, /1 of 2 recorded Work IQ calls failed; 1 succeeded/);
                assert.match(text, /AI quality results are recorded/);
                assert.doesNotMatch(text, /request failed/i);
                assert.equal(await page.locator(".interaction-insights .assessment-check .assessment-value").getByText("1 passed · 0 failed", { exact: true }).count(), 3);
            } else if (kind === "evaluator-error") {
                assert.match(text, /recorded Work IQ call completed/);
                assert.match(text, /AI quality assessment could not complete/);
                assert.match(text, /evaluator failure, not a failed answer or action verdict/);
                assert.doesNotMatch(text, /Work IQ sign-in|PRIVATE_EVALUATOR_ERROR/);
            } else if (kind === "insufficient") {
                assert.match(text, /AI assessment found insufficient recorded evidence/);
                assert.doesNotMatch(text, /evaluator failure|No AI quality assessment is recorded/);
                assert.equal(await page.locator(".interaction-insights .assessment-check .assessment-value").getByText("Not enough evidence", { exact: true }).count(), 3);
            } else {
                assert.match(text, /Work IQ sign-in was required/);
                assert.match(text, /No AI quality assessment is recorded/);
                const later = await readRequest(f.inputs[1].record.scenarioId);
                assert.match(later, /AI quality results are recorded/);
                assert.doesNotMatch(later, /sign-in was required|call failed/);
                assert.equal(await page.locator(".interaction-insights .assessment-check .assessment-value").getByText("1 passed · 0 failed", { exact: true }).count(), 3);
            }
            assert.deepEqual(pageErrors, []); assert.deepEqual(writes, []);
            assert.equal(f.calls.length, beforeCalls);
            assert.deepEqual((await loadBoardState(f.context)).personalEvaluation, before.personalEvaluation);
        });
    }
});

test("an open request refreshes per-attempt evaluator status without changing the quality basis or replaying", async t => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const f = await evaluationFixture(t, async () => { await held; throw new Error("PRIVATE_DELAYED_EVALUATOR_ERROR"); });
    await materializeEvaluationSource(f);
    f.input.expectedSourceRevision = (await loadBoardState(f.context)).evidenceRevision;
    f.input.scenarioIds = [f.inputs[0].record.scenarioId]; f.input.maxAiCredits = 30;
    const runtime = await startServer(f.context, createExportController(f.context), {
        port: 0, collector: { timers: false }, evaluation: { evaluatorFactory: f.options.evaluatorFactory },
    });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 950 } });
    t.after(async () => { release(); await f.controller.settle(); await browser.close(); await runtime.close(); });
    await page.goto(runtime.url + "#request?request=" + f.input.scenarioIds[0] + "&range=capture");
    const summary = page.locator(".interaction-insights [data-review-status]");
    await summary.waitFor();
    assert.match(await summary.innerText(), /No AI quality assessment is recorded/);
    const before = await loadBoardState(f.context);
    await f.controller.start("fixture", f.input);
    while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
    await (await revealStoredRefresh(page)).click();
    await page.waitForFunction(() => document.querySelector(".interaction-insights [data-review-status]")?.textContent.includes("assessment is pending"));
    release(); await f.controller.settle();
    await (await revealStoredRefresh(page)).click();
    await page.waitForFunction(() => document.querySelector(".interaction-insights [data-review-status]")?.textContent.includes("evaluator failure"));
    const after = await loadBoardState(f.context);
    assert.equal(after.evidenceRevision, before.evidenceRevision);
    assert.equal(after.personalEvaluation.overrideRevision, before.personalEvaluation?.overrideRevision ?? 0);
    assert.equal(f.calls.length, 1);
    assert.match(await summary.innerText(), /recorded Work IQ call completed/);
    assert.doesNotMatch(await summary.innerText(), /PRIVATE_DELAYED|Work IQ sign-in/);
});

test("whole-context failure detail visual evidence", { timeout: 60000 }, async t => {
    const record = fixture("failure-visual");
    Object.assign(record, { title: "Invented file request", followUpPrompts: [],
        userPrompt: { text: "Read the example document and explain what happened.", status: "full", provenance: "human-authored" } });
    Object.assign(record.toolCalls[0], {
        tool: "workiq-fetch_blob", toolCallId: "invented-call-27", toolSucceeded: false, reportedOutcome: "failed", apiResults: [],
        startedAt: "2026-10-01T12:00:01.000Z", completedAt: "2026-10-01T12:00:01.738Z", durationMs: 738,
        requestedApiPath: "/drives/invented-drive/items/example-document/content",
        requestArgs: { path: "/drives/invented-drive/items/example-document/content" },
    });
    const { context } = await privateFixture(t, [record]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        writeText() { throw Error("Disabled in visual evidence"); }, readText() { throw Error("No OS clipboard"); },
    } }));
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [375, 1], [1440, 2], [375, 2]]) {
        await page.setViewportSize({ width, height: 1100 });
        await page.goto(runtime.url + "#request?request=failure-visual&range=capture");
        await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        const details = page.locator("#requestContent").getByText("Technical details", { exact: true });
        if (!await details.evaluate(node => node.parentElement.open)) await details.click();
        const args = page.locator("#requestContent").getByText("Tool input (recorded)", { exact: true }).first();
        if (!await args.evaluate(node => node.parentElement.open)) await args.click();
        await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
        await page.evaluate(() => document.fonts.ready);
        if (process.env.WIRE_FAILURE_PROOFS) {
            await mkdir(process.env.WIRE_FAILURE_PROOFS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WIRE_FAILURE_PROOFS, `${theme}-${width}-${scale * 100}.png`), fullPage: true });
            const detailBounds = await page.locator(".technical-detail").boundingBox();
            await page.screenshot({ path: path.join(process.env.WIRE_FAILURE_PROOFS, `detail-${theme}-${width}-${scale * 100}.png`), fullPage: true, clip: detailBounds });
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${theme}/${width}/${scale} page overflow`);
    }
});

test("technical identifier copy stays next to its value and missing evidence is explained", { timeout: 30000 }, async t => {
    const record = fixture("failure-clarity");
    Object.assign(record.toolCalls[0], {
        tool: "workiq-fetch_blob", toolCallId: "invented-failed-call", toolSucceeded: false,
        reportedOutcome: "failed", apiResults: [], requestedApiPath: "/drives/invented/items/example/content",
        requestArgs: { path: "/drives/invented/items/example/content" },
    });
    const { context } = await privateFixture(t, [record]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        writeText: async text => { window.copiedText = text; }, readText() { throw Error("No OS clipboard"); },
    } }));
    await page.goto(runtime.url + "#request?request=failure-clarity&range=capture");
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
    await page.locator("#requestContent").getByText("Technical details", { exact: true }).click();
    const copy = page.getByRole("button", { name: "Copy tool call id", exact: true });
    const gap = await copy.evaluate(button => {
        const range = document.createRange();
        range.selectNodeContents(button.parentElement.querySelector("code"));
        return button.getBoundingClientRect().left - range.getBoundingClientRect().right;
    });
    assert.ok(gap >= 0 && gap <= 16, `Copy/value gap ${gap}px must be <=16px`);
    assert.doesNotMatch(await page.locator(".request-outcome").innerText(), /Failure details were not recorded/);
});

test("bounded failure, success, relationship and HTTP cases share honest details and exact accessible copy", { timeout: 60000 }, async t => {
    const cases = [
        ["legacy", false, [], null, "Failure cause unavailable in retained evidence"],
        ["source-absent", false, [], { version: 1, reason: "no-structured-error", code: null }, "source completion records failure"],
        ["excluded", false, [], { version: 1, reason: "error-details-excluded", code: null }, "excluded by WIRE"],
        ["tool-code", false, [], { version: 1, reason: "error-code-recorded", code: "failure", messageStatus: "text-excluded", messageSignal: "access-denial" }, "Tool error: failure; Tool error mentions access denial"],
        ["success", true, [{ index: 0, statusCode: 200 }], null, null],
        ["returned-failure", true, [{ index: 0, statusCode: 403, errorCode: "Forbidden" }], null, "Reported HTTP 403: Forbidden"],
        ["timeout-with-returned-status", false, [{ index: 0, statusCode: 403, errorCode: "Forbidden" }, { index: 1, statusCode: 503 }],
            { version: 1, reason: "error-code-recorded", code: "failure", messageStatus: "text-excluded", messageSignal: "request-timeout" },
            "Tool reported an MCP request timeout (-32001)."],
    ];
    const records = cases.map(([name, success, apiResults, failureEvidence], index) => {
        const record = fixture(name), call = record.toolCalls[0];
        Object.assign(call, { toolCallId: index === 4 ? "invented-" + "long-identifier-".repeat(24) + "  " : `invented-${name}`,
            toolSucceeded: success, reportedOutcome: success ? "succeeded" : "failed", apiResults, failureEvidence,
            requestedApiPath: "/drives/" + "invented-long-path-".repeat(20) + "/content" });
        if (index === 1) call.parentInvocationEvidence = "source-field-absent";
        if (index === 4) Object.assign(call, { parentToolCallId: "invented-parent", parallelGroup: "invented-group" });
        if (index === 2) { record.sourceHost = "unknown"; record.workloadKind = "unknown"; }
        return record;
    });
    const owned = fixture("owned");
    owned.toolCalls = [];
    owned.httpRecords = [{ recordId: "invented-http", method: "GET", path: "/me/messages", status: 503,
        startedAt: "2026-09-30T12:00:01.000Z", endedAt: "2026-09-30T12:00:02.000Z", durationMs: 1000,
        observedGraphHttp: true, evidenceLevel: "owned-http" }];
    records.push(owned);
    const { context } = await privateFixture(t, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: "reduce" });
    const errors = [], external = [], unexpectedWrites = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        const url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin) external.push(url.origin);
        if (request.method() !== "GET" && !["/api/connect", "/api/snapshot", "/api/collection/status", "/api/assessment/detail",
            "/api/assessment/overview", "/api/evaluation/automatic/summary"].includes(url.pathname)) unexpectedWrites.push(url.pathname);
    });
    t.after(async () => { await browser.close(); await runtime.close(); assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(unexpectedWrites, []); });
    await page.addInitScript(() => {
        window.clipboardWrites = [];
        Object.defineProperty(navigator, "clipboard", { value: {
            readText() { throw Error("No OS clipboard"); },
            writeText(text) { window.clipboardWrites.push(text); return new Promise((resolve, reject) => { window.resolveCopy = resolve; window.rejectCopy = reject; }); },
        } });
    });
    for (const [name, success, , , expected] of cases) {
        await page.goto(runtime.url + `#request?request=${name}&range=capture`);
        await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
        const outcome = await page.locator(".request-outcome").innerText();
        if (expected) assert.ok(outcome.includes(expected), outcome);
        else assert.equal(await page.locator(".action-error").count(), 0);
        assert.match(outcome, success ? /Worked/ : /Tool failed/);
        if (name === "timeout-with-returned-status") {
            assert.match(outcome, /Reported HTTP 403: Forbidden/);
            assert.match(outcome, /Reported HTTP 503/);
            assert.doesNotMatch(outcome, /No HTTP status|no downstream cause|downstream cause was established/i,
                "A protocol timeout must not deny independent returned HTTP evidence");
        }
        await page.locator("#requestContent").getByText("Technical details", { exact: true }).click();
        const facts = page.locator(".technical-facts");
        const field = label => facts.locator("dt").filter({ hasText: new RegExp(`^${label}$`) }).evaluate(node => node.nextElementSibling.textContent);
        assert.equal(await field("HTTP observed"), "No");
        if (name === "source-absent") assert.equal(await field("Parent invocation"), "Not supplied by source");
        if (name === "legacy") {
            assert.equal(await field("Parent invocation"), "Unavailable in retained evidence");
            assert.equal(await field("Parallel group"), "Not collected by this adapter");
            await facts.getByRole("button", { name: "About Parent invocation", exact: true }).focus();
            await page.keyboard.press("Enter");
            assert.match(await page.getByRole("tooltip").innerText(), /cannot establish.*source omitted.*earlier collection/);
            await page.keyboard.press("Escape");
            await facts.getByRole("button", { name: "About Parallel group", exact: true }).click();
            assert.match(await page.getByRole("tooltip").innerText(), /WIRE collection limit.*not evidence.*serially/);
            await page.keyboard.press("Escape");
        }
        if (name === "excluded") assert.equal(await field("Parallel group"), "Unavailable in retained evidence");
        if (name !== "success") continue;
        for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [375, 1], [1440, 2], [375, 2]]) {
            await page.setViewportSize({ width, height: 1100 });
            await chooseTheme(page, theme);
            await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            for (const [label, value] of [["tool call id", records[4].toolCalls[0].toolCallId], ["parent invocation", "invented-parent"], ["parallel group", "invented-group"]]) {
                const copy = facts.getByRole("button", { name: "Copy " + label, exact: true });
                const geometry = await copy.evaluate(button => {
                    const code = button.parentElement.querySelector("code"), cell = button.closest("dd");
                    const range = document.createRange(); range.selectNodeContents(code);
                    const text = range.getBoundingClientRect(), target = button.getBoundingClientRect();
                    return { gap: target.left - text.right, boxGap: target.left - code.getBoundingClientRect().right,
                        wrapped: text.height > parseFloat(getComputedStyle(code).lineHeight) + 1,
                        fontSize: parseFloat(getComputedStyle(code).fontSize), width: target.width, height: target.height,
                        font: getComputedStyle(code).fontFamily === getComputedStyle(cell).fontFamily,
                        size: getComputedStyle(code).fontSize === getComputedStyle(cell).fontSize };
                });
                assert.ok(geometry.width >= 44 && geometry.height >= 44);
                assert.ok(geometry.boxGap >= -1 && geometry.boxGap <= 16, JSON.stringify(geometry));
                if (!geometry.wrapped) assert.ok(geometry.gap >= -1 && geometry.gap <= 16, JSON.stringify(geometry));
                assert.ok(geometry.font && geometry.size);
                await copy.focus(); await page.keyboard.press("Enter");
                assert.equal(await copy.getAttribute("data-copy-state"), "pending");
                assert.equal(await page.evaluate(() => window.clipboardWrites.at(-1)), value);
                const count = await page.evaluate(() => window.clipboardWrites.length);
                await page.keyboard.press("Enter");
                assert.equal(await page.evaluate(() => window.clipboardWrites.length), count);
                await page.evaluate(() => window.resolveCopy());
                await page.waitForFunction(() => document.querySelector(".technical-facts .ux-copy[data-copy-state=success]"));
                assert.equal(await copy.getAttribute("data-copy-state"), "success");
                await copy.click();
                await page.evaluate(() => window.rejectCopy(new DOMException("Invented denial", "NotAllowedError")));
                await page.waitForFunction(() => document.querySelector(".technical-facts .ux-copy[data-copy-state=error]"));
                assert.equal(await copy.getAttribute("data-copy-state"), "error");
                assert.match(await copy.locator("..").getByRole("alert").innerText(), /permission was denied/);
                assert.ok(await copy.locator("..").getByRole("alert").isVisible());
            }
        }
        await page.evaluate(() => { document.documentElement.style.fontSize = "16px"; });
        await page.setViewportSize({ width: 1440, height: 1100 });
    }
    await page.goto(runtime.url + "#request?request=owned&range=capture&layer=http");
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
    assert.match(await page.locator("#requestContent").innerText(), /Explicit HTTP recorder[\s\S]*Recorded HTTP status 503/);
    assert.doesNotMatch(await page.locator("#requestContent").innerText(), /Tool error:|Tool failed|Failure cause unavailable/);
});
