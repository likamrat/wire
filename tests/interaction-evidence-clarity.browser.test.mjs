import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";
import { createTimingPresentation, createAssessmentWording, renderRecordedTiming, assessmentPresentationStyles } from "../web/assessment-presentation.mjs";
import { createReportComparison } from "../web/report-comparison.mjs";
import { compareFrozenReportFacts } from "../lib/frozen-report-comparison.mjs";
import { screenTokens } from "../web/tokens.mjs";
import { recordedResponseTiming } from "../lib/response-timing.mjs";

function evidenceRecord() {
    const record = fixture("invented-evidence-clarity");
    record.sourceSessionName = "Planning notes";
    record.userPrompt = { text: "Find the planning notes and list the unresolved decisions.",
        status: "full", sourceEventId: "invented-prompt", sourceTimestamp: "2026-10-01T12:00:00.000Z",
        authorship: { actor: "user", basis: "source-user" } };
    record.followUpPrompts = [];
    record.responseTiming = recordedResponseTiming([
        { id: "invented-prompt", type: "user.message", timestamp: record.userPrompt.sourceTimestamp, data: { messageId: "invented-message" } },
        { id: "invented-reply", type: "assistant.message", timestamp: "2026-10-01T12:00:11.850Z",
            data: { wireResponseMetadataVersion: 1, finalAnswer: true, hasResponseText: true, hasToolRequests: false,
                turnId: "invented-turn", originatingMessageId: "invented-message" } },
        { id: "invented-turn-end", type: "assistant.turn_end", timestamp: "2026-10-01T12:00:11.851Z",
            data: { turnId: "invented-turn" } },
    ], record.userPrompt);
    record.promptAssociation = "Nearest preceding recorded user.message; association is inferred, not a proven causal link. Follow-ups remain separate prompt-group scenarios.";
    record.coverageNote = "Recorded Work IQ invocation, not observed Graph HTTP. Result entity/body content excluded. Missing completions and truncated logs are disclosed in the source roster.";
    record.toolCalls = [11850, 7740, 325, null, 635, 1091].map((durationMs, index) => ({
        tool: index % 2 ? "workiq-get_schema" : "workiq-search_paths",
        toolCallId: `invented-call-${index}`, startEventId: `invented-start-${index}`,
        completionEventId: durationMs === null ? null : `invented-end-${index}`,
        startedAt: `2026-10-01T12:0${index}:01Z`, durationMs,
        toolSucceeded: index >= 4 ? false : durationMs === null ? null : true,
        reportedOutcome: index >= 4 ? "failed" : durationMs === null ? "unknown" : "succeeded",
        apiResults: [], requestArgs: { path: "invented-schema" },
        ...(index >= 4 ? { failureEvidence: { version: 1, reason: "error-code-recorded", code: "failure",
            messageStatus: "text-excluded", messageSignal: index === 4 ? "mcp-server-path-not-found" : null,
            ...(index === 4 ? { messageSource: "workiq-error-json" } : {}) } } : {}),
    }));
    return record;
}

test("interaction evidence is readable, ms-first and private across reader states", { timeout: 60000 }, async t => {
    const cleanup = [], errors = [], unexpected = [];
    const record = evidenceRecord();
    const { context } = await privateFixture({ after: fn => cleanup.push(fn) }, [record]);
    const before = await loadBoardState(context);
    const start = process.env.WIRE_EVIDENCE_BASELINE
        ? (await import(pathToFileURL(path.join(process.env.WIRE_EVIDENCE_BASELINE, "lib", "server.mjs")).href)).startServer : startServer;
    const runtime = await start(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const phase = process.env.WIRE_EVIDENCE_PROOF_PHASE ?? "after", proof = process.env.WIRE_EVIDENCE_PROOFS;
    page.setDefaultTimeout(3000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET"
            || ["/api/snapshot", "/api/connect", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview"].includes(url.pathname))) return route.continue();
        unexpected.push(url.pathname);
        return route.abort();
    });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation", "pseudonymKey"]) assert.deepEqual(after[key], before[key]);
        } finally { for (const fn of cleanup) await fn(); }
    });
    if (proof) await mkdir(proof, { recursive: true });
    await page.goto(runtime.url);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 100], [768, 100], [390, 200]]) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => document.documentElement.style.fontSize = "100%");
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale}%`, scale);
        await page.locator(".request-card-open").click();
        await expect(page.locator(".interaction-response.reader-response-availability")).not.toContainText("Reading response");
        const source = page.locator('[data-reader-section="source"]');
        if (await source.locator("button.reader-section-toggle").getAttribute("aria-expanded") === "true") await source.locator("button.reader-section-toggle").click();
        if (phase !== "before") {
            await expect(page.locator("#requestContent .response-timing data")).toHaveText("11,850 ms (11.85 s)");
            await expect(page.locator(".request-card-open .response-timing")).toHaveCount(0);
            await expect(page.locator('[data-tool-call-id="invented-call-0"] data.call-duration')).toHaveText("11,850 ms (11.85 s)");
            await expect(page.locator('[data-tool-call-id="invented-call-2"] data.call-duration')).toHaveText("325 ms");
            await expect(page.locator('[data-tool-call-id="invented-call-3"] .call-duration')).toHaveText("Not recorded");
            await expect(page.locator('[data-tool-call-id="invented-call-4"]')).toContainText("Work IQ could not find the requested address");
            await expect(page.locator(".reader-response-availability")).toContainText("Copilot reply");
            await expect(page.locator(".reader-response-availability")).not.toContainText("Capture is off");
            await expect(page.locator("#requestContent > .reader-copy-scope")).toHaveCount(0);
            await expect(page.locator("#requestContent")).not.toContainText("Copy uses unmasked text");
            for (const primary of await page.locator("#requestContent .duration-primary:visible").all()) {
                const geometry = await primary.evaluate(node => {
                    const range = document.createRange(); range.selectNodeContents(node);
                    return { fragments: range.getClientRects().length, overflow: node.scrollWidth - node.clientWidth };
                });
                assert.equal(geometry.fragments, 1, "Value and ms remain one adjacent text group");
                assert.ok(geometry.overflow <= 1);
            }
        }
        await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop = 0);
        if (proof) await page.locator("#contextSidebar").screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-${scale}-reader.png`) });
        await source.locator("button.reader-section-toggle").click();
        await source.scrollIntoViewIfNeeded();
        if (phase !== "before") {
            assert.equal(await source.locator(".duration-primary").evaluate(node => {
                const range = document.createRange(); range.selectNodeContents(node); return range.getClientRects().length;
            }), 1);
            await expect(source).toContainText("Planning notes");
            await expect(source).toContainText("Record identifiers");
            await expect(source.locator(".reader-identifier")).toHaveCount(0);
            await source.getByRole("button", { name: "Record identifiers" }).click();
            await expect(source.locator(".reader-identifier")).not.toHaveCount(0);
            await source.getByRole("button", { name: "Record identifiers" }).click();
            await expect(source.locator(".reader-identifier")).toHaveCount(0);
        }
        if (proof) await page.locator("#contextSidebar").screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-${scale}-source.png`) });
        assert.ok(await page.locator("#contextSidebarBody").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.locator("#closeContextSidebar").click();
        await page.waitForFunction(() => !document.querySelector("#contextSidebar").open);
    }
    if (phase === "before") return;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => {
        document.documentElement.style.fontSize = "100%";
        window.copied = [];
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => window.copied.push(text) } });
    });
    await page.locator(".request-card-open").click();
    const copy = page.locator('[data-reader-section="prompt"]').getByRole("button", { name: "Copy prompt", exact: true });
    await copy.scrollIntoViewIfNeeded();
    const beforeCopy = await page.locator('[data-reader-section="activity"]').boundingBox();
    const copyBox = await copy.boundingBox();
    await page.mouse.click(copyBox.x + copyBox.width / 2, copyBox.y + copyBox.height / 2);
    await expect(copy).toHaveAttribute("data-copy-state", "success");
    assert.deepEqual(await page.evaluate(() => window.copied), [record.userPrompt.text]);
    assert.equal((await page.locator('[data-reader-section="activity"]').boundingBox()).y, beforeCopy.y);
    await page.evaluate(() => window.oldPrivate = document.querySelector("#requestContent .full-text-content"));
    await page.locator("#closeContextSidebar").click();
    await page.waitForFunction(() => !document.querySelector("#contextSidebar").open);
    assert.equal(await page.evaluate(() => window.oldPrivate.textContent), "");
});

test("timing widgets keep value and unit adjacent without changing missing or zero measurements", async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const timing = createTimingPresentation(undefined, { compact: true });
    const rows = [
        timing.fromSummary({ sampleCount: 2, p50Ms: 325, p95Ms: 11850 }, 3, "tool-start-to-completion"),
        timing.fromSummary({ sampleCount: 1, p50Ms: 90061004, p95Ms: 90061004 }, 1, "recorded-request-to-final-answer"),
        timing.fromSummary({ sampleCount: 1, p50Ms: 0, p95Ms: 0 }, 1, "http-dispatch-to-response-headers"),
        timing.fromSummary({ sampleCount: 0, p50Ms: null, p95Ms: null }, 1, "http-dispatch-to-transport-error"),
    ];
    await page.setContent(`<style>${screenTokens}${assessmentPresentationStyles}body{margin:16px;background:var(--paper);color:var(--ink);font-family:var(--font)}main{max-width:100%}</style><main></main>`);
    await page.addScriptTag({ content: `window.renderTiming = ${renderRecordedTiming.toString()}` });
    await page.evaluate(rows => window.renderTiming(document.querySelector("main"), rows, { compact: true }), rows);
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 100], [768, 100], [390, 200]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(({ theme, scale }) => {
            document.documentElement.dataset.evidenceTheme = theme;
            document.documentElement.style.fontSize = `${scale}%`;
        }, { theme, scale });
        await expect(page.locator('data[value="11850"]')).toHaveText("11,850 ms (11.85 s)");
        await expect(page.locator('data[value="0"]')).toHaveText("0 ms");
        await expect(page.locator("data:not([value])")).toHaveText("Not measured");
        const measures = await page.locator(".duration-primary").evaluateAll(nodes => nodes.map(node => {
            const range = document.createRange(); range.selectNodeContents(node);
            const rect = node.getBoundingClientRect();
            return { fragments: range.getClientRects().length, right: rect.right, width: innerWidth };
        }));
        assert.ok(measures.every(value => value.fragments === 1 && value.right <= value.width), JSON.stringify({ theme, width, scale, measures }));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
});

test("live saved-report and period comparisons keep signed milliseconds and seconds equivalent", { timeout: 30000 }, async t => {
    const cases = [
        [-11850, "\u221211,850 ms (\u221211.85 s)"], [11850, "+11,850 ms (+11.85 s)"],
        [-325, "\u2212325 ms"], [325, "+325 ms"], [0, "Unchanged"],
    ];
    const records = cases.flatMap(([delta], index) => [12000, 12000 + delta].map((durationMs, side) => {
        const record = fixture(`invented-change-${index}-${side}`);
        const startedAt = `2026-01-${10 + index * 2 + side}T12:00:00.000Z`;
        record.userPrompt.sourceEventId = `invented-change-prompt-${index}-${side}`;
        record.userPrompt.sourceTimestamp = startedAt;
        record.followUpPrompts = [];
        Object.assign(record.toolCalls[0], { startedAt, durationMs,
            completedAt: new Date(Date.parse(startedAt) + durationMs).toISOString(), completionEventId: `invented-change-end-${index}-${side}` });
        return record;
    }));
    const cleanup = [], errors = [], denied = [];
    const { context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(), page = await browser.newPage({ timezoneId: "UTC", reducedMotion: "reduce" });
    const saved = await browser.newPage();
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            assert.deepEqual(await loadBoardState(context), before);
        } finally { for (const fn of cleanup) await fn(); }
    });
    page.on("pageerror", error => errors.push(error.message));
    saved.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET" || [
            "/api/snapshot", "/api/collection/status", "/api/assessment/overview",
            "/api/evaluation/automatic/summary", "/api/period-comparison",
        ].includes(url.pathname))) return route.continue();
        denied.push(url.pathname); return route.abort();
    });
    await saved.setContent("<main></main>");
    await saved.addScriptTag({ content: `const wording = (${createAssessmentWording.toString()})();
        const timing = (${createTimingPresentation.toString()})(() => {}, { compact: true });
        window.formatter = (${createReportComparison.toString()})(wording, timing.duration);` });
    for (const [index, [delta, expected]] of cases.entries()) {
        const from = `2026-01-${10 + index * 2}`, to = `2026-01-${11 + index * 2}`;
        await page.goto(runtime.url + `#analyze?compare=periods&aFrom=${from}&aTo=${from}&bFrom=${to}&bTo=${to}`);
        await page.locator("#createPeriodReport:visible").waitFor();
        await expect(page.locator(".compare-latency .compare-value-detail").first()).toContainText(expected);
        await expect(page.locator(".compare-whole-measure").filter({ has: page.getByRole("heading", { name: "Tool latency", exact: true }) }))
            .toContainText(delta === 0 ? "Typical time was unchanged." : expected);
        await expect(page.locator(".compare-whole-measure").filter({ has: page.getByRole("heading", { name: "Request to final response", exact: true }) }))
            .toContainText("There is not enough recorded timing to compare the periods.");

        const report = (id, value) => ({
            schemaVersion: 1, bundleId: `export-${id}`, snapshotHash: id.repeat(64), disclosureReviewed: true,
            patternVersion: 1, toolRows: [], patterns: [],
            metrics: [{ metric: "speed", kind: "duration", definitionId: "tool-duration", definitionVersion: 1,
                unit: "ms", basis: "observed", aggregation: "median", boundary: "tool-start-to-completion",
                state: "available", value, coverage: { count: 1, eligible: 1 } }],
            scope: { selectionKind: "selected", timeZone: "UTC", collectionDefinition: "synthetic", callTimesAvailable: false, historyComplete: false },
        });
        const model = compareFrozenReportFacts(report("a", 12000), report("b", 12000 + delta));
        await saved.evaluate(model => window.formatter.render(document.querySelector("main"), model), model);
        await expect(saved.locator(".comparison-delta")).toHaveText(expected);
    }
});
