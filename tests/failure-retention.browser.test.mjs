import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { privateFixture, chooseTheme, navigateMain } from "./helpers.mjs";
import { createCollector, retainEvent } from "../lib/collector.mjs";
import { extractScenarios } from "../lib/history.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController, buildSanitizedRecord } from "../lib/export.mjs";
import { buildRequestActivity } from "../lib/activity-analytics.mjs";
import { createCorpusSources } from "../lib/search-corpus-sources.mjs";
import { indexSearchText, rankTextSearch } from "../lib/search-text.mjs";
import { pdfDocumentText } from "../lib/search-corpus-pdf.mjs";
import { readSavedArtifactFile } from "../lib/report-artifacts.mjs";

test("paired ask failures survive incremental collection and reach cards, reader, Search and frozen error reports", { timeout: 90000 }, async t => {
    const cleanup = [], { root, context } = await privateFixture({ after: fn => cleanup.push(fn) }, []);
    const sourceId = randomUUID(), appDbPath = path.join(root, "data.db"), sessionRoot = path.join(root, "session-state");
    const db = new DatabaseSync(appDbPath);
    db.exec("PRAGMA user_version=156; CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);");
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(sourceId, "Invented policy failures", "chat", null, "local");
    db.close();
    await mkdir(path.join(sessionRoot, sourceId), { recursive: true });
    const file = path.join(sessionRoot, sourceId, "events.jsonl"), now = Date.now() - 30000;
    const event = (id, type, data, offset) => ({ id, type, data, timestamp: new Date(now + offset).toISOString() });
    const start = number => event(`start-${number}`, "tool.execution_start", {
        toolName: "workiq-ask", toolCallId: `call-${number}`, arguments: { question: `Read invented planning notes ${number}.` },
    }, number * 100);
    const message = "The invented source policy is unavailable. The request was blocked before processing.";
    const end = number => event(`end-${number}`, "tool.execution_complete", {
        toolCallId: `call-${number}`, success: ![5, 6].includes(number),
        ...([5, 6].includes(number) ? { error: { code: "failure", message: "MCP server 'workiq': " + JSON.stringify({
            response: null, error: message, errorCode: "SourcePolicyUnavailable",
            conversationId: `EXCLUDED_CONVERSATION_${number}`, requestId: `EXCLUDED_REQUEST_${number}`, recoveryAction: "None",
        }) } } : {}),
    }, number * 100 + 50);
    const jsonl = rows => rows.map(row => JSON.stringify(row) + "\n").join("");
    await writeFile(file, jsonl([
        event("session", "session.start", { version: 1, sessionId: sourceId }, 0),
        event("prompt", "user.message", { content: "Review the invented planning conversation and notes." }, 1),
        ...[1, 2, 3, 4].flatMap(number => [start(number), end(number)]), start(5), start(6),
    ]));
    let collector = await createCollector(context, { timers: false }), runtime, browser;
    t.after(async () => {
        await browser?.close();
        if (runtime) await runtime.close(); else await collector.close();
        for (const fn of cleanup) await fn();
    });
    await collector.configure({ appDbPath, sessionRoot, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    await collector.collectNow();
    assert.deepEqual((await loadBoardState(context)).evidence[0].toolCalls.slice(4).map(call => call.reportedOutcome), ["unknown", "unknown"]);
    await collector.close();
    collector = await createCollector(context, { timers: false });
    await appendFile(file, jsonl([end(5), end(6), ...[7, 8].flatMap(number => [start(number), end(number)])]));
    const original = await readFile(file);
    await collector.collectNow();
    const state = await loadBoardState(context), records = state.evidence, record = records[0], activity = buildRequestActivity(records);
    assert.equal(records.length, 1);
    assert.equal(record.toolCalls.length, 8);
    assert.deepEqual(activity.tool.map(row => row.outcome), ["success", "success", "success", "success", "failure", "failure", "success", "success"]);
    assert.deepEqual(activity["reported-api"], []);
    assert.equal(state.personalEvaluation, undefined);
    for (const number of [5, 6]) {
        const call = record.toolCalls[number - 1];
        assert.equal(call.failureEvidence.diagnostic.message, message);
        assert.equal(call.failureEvidence.code, "SourcePolicyUnavailable");
        assert.equal(call.completionEventId, `end-${number}`);
        assert.equal(call.resultEvidence.statusCode, null);
    }
    const index = JSON.parse(await readFile(path.join(context.dataDir, "collector", "index.json"), "utf8"));
    const checkpoint = await readFile(path.join(context.dataDir, "collector", index.fingerprint, sourceId + ".json"), "utf8");
    assert.match(checkpoint, /SourcePolicyUnavailable/);
    assert.doesNotMatch(checkpoint + JSON.stringify(state), /EXCLUDED_|recoveryAction/);
    const frame = await createCorpusSources(context, { source: () => collector.assessmentSource(state) }).scan();
    for (const query of ["SourcePolicyUnavailable", "blocked before processing"]) {
        const matches = await rankTextSearch(frame.entries.filter(entry => entry.coverage.layer === "tool").map(indexSearchText),
            query, ["action"], new AbortController().signal);
        assert.equal(matches.length, 2);
        assert.equal(new Set(matches.map(match => match.id)).size, 2);
    }
    await collector.close();
    runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: "reduce" });
    const errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin !== new URL(runtime.url).origin) { external.push(route.request().url()); return route.abort(); }
        return route.continue();
    });
    await page.goto(runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    const proofs = process.env.WIRE_FAILURE_PROOFS;
    if (proofs) await mkdir(proofs, { recursive: true });
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        const card = page.locator(".request-card-open");
        await expect(card).toContainText("8 recorded calls / 6 completed / 2 failed");
        for (const number of [5, 6]) {
            const reason = card.locator(".request-card-reason").filter({ hasText: `Call #${number} failed` });
            await expect(reason).toContainText(message);
            await expect(reason).toContainText("SourcePolicyUnavailable");
        }
        await expect(card).not.toContainText("could not extract");
        if (proofs) await page.screenshot({ path: path.join(proofs, `ask-errors-card-${theme}.png`) });
        await card.click();
        for (const number of [5, 6]) {
            const call = page.locator(`[data-reader-section=activity] [data-tool-call-id="call-${number}"]`);
            await expect(call.locator(".reader-call-summary")).toContainText(message);
            if (await call.locator(".reader-call-toggle").getAttribute("aria-expanded") !== "true") await call.locator(".reader-call-toggle").click();
            await expect(call.locator(".technical-detail .reader-error-message")).toHaveText(message);
        }
        await expect(page.locator("#requestContent")).not.toContainText("EXCLUDED_");
        if (proofs) await page.screenshot({ path: path.join(proofs, `ask-errors-reader-${theme}.png`) });
        await page.locator("#closeContextSidebar").click();
        await page.waitForFunction(() => !document.querySelector("#contextSidebar").open
            && !document.querySelector("#contextSidebar").getAnimations().length);
    }
    await page.locator("#wireSearch").click();
    await page.locator("#wireSearch").fill("SourcePolicyUnavailable");
    await expect(page.locator(".wire-search-hit")).toHaveCount(2);
    await page.locator(".wire-search-hit").first().click();
    await expect(page.locator("#requestContent")).toContainText(message);
    await page.reload();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#requestContent")).toContainText(message);
    await page.locator("#closeContextSidebar").click();
    await chooseTheme(page, "light");
    await navigateMain(page, "reports");
    const prepared = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator('[data-report-preset="errors"]').click();
    const response = await prepared;
    let preview = await response.json();
    assert.equal(response.status(), 200, preview.error);
    await expect(page.frameLocator(".report-frame").locator("body")).toContainText(message);
    assert.equal(preview.records.length, 1);
    assert.equal(preview.snapshot.reportPopulation.reference.length, 1);
    assert.match(JSON.stringify(preview.snapshot.resultText), /SourcePolicyUnavailable/);
    await page.getByRole("button", { name: "Save as: HTML", exact: true }).click();
    for (const format of ["pdf", "json", "markdown"]) {
        const next = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.locator(`#formatOptions input[value="${format}"]`).check();
        const response = await next;
        assert.equal(response.status(), 200);
        preview = await response.json();
    }
    await page.locator("#reportFileOptions").getByRole("button", { name: "Done", exact: true }).click();
    if (proofs) await page.screenshot({ path: path.join(proofs, "ask-errors-report.png") });
    const saving = page.waitForResponse(response => response.url().endsWith("/api/export"));
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    assert.equal((await saving).status(), 200);
    const saved = await loadBoardState(context);
    assert.equal(saved.exports.length, 1);
    for (const [format, name] of [["html", "product-report.html"], ["pdf", "product-report.pdf"], ["json", "product-report.json"], ["markdown", "product-report.md"]]) {
        const file = await readSavedArtifactFile(context, saved, saved.exports[0].bundleId, "report", format);
        const expected = typeof preview.files[name] === "string" ? Buffer.from(preview.files[name]) : Buffer.from(preview.files[name].data, "base64");
        assert.deepEqual(file.bytes, expected);
        const text = format === "pdf" ? (await pdfDocumentText(file.bytes)).content : file.bytes.toString();
        assert.match(text, /SourcePolicyUnavailable/);
        assert.match(text, /invented source policy is unavailable/);
        assert.doesNotMatch(text, /EXCLUDED_|could not extract/);
    }
    await page.getByRole("button", { name: "Open saved report", exact: true }).click();
    await expect(page.locator("#savedReportReader").frameLocator("iframe").locator("body")).toContainText(message);
    assert.deepEqual((await loadBoardState(context)).evidence, records);
    assert.deepEqual(await readFile(file), original);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
});

test("supported failure families keep their operation, recorded reason and honest gaps across reading and report output", { timeout: 60000 }, async t => {
    const wrapped = value => ({ error: { code: "failure", message: "MCP server 'workiq': " + JSON.stringify(value) } });
    const cases = [
        ["unavailable", wrapped({ error: "Error: Error executing tool: No MCP server was found for path '/invented/service'. Use search to discover valid MCP server paths." }), "No MCP server was found"],
        ["invocation", { error: { code: -32602, message: "The supplied invocation arguments are invalid." } }, "supplied invocation arguments"],
        ["access", { error: { code: "AccessDenied", message: "The requested operation was denied.",
            details: [{ code: "MissingPermission", message: "The recorded permission is missing." }] } }, "recorded permission is missing"],
        ["status", wrapped({ statusCode: 503, data: null, error: null }), "503"],
        ["returned", wrapped({ results: [{ statusCode: 200 }, { statusCode: 400,
            error: { error: { code: "BadRequest", message: "The second returned entry was rejected." } } }] }), "second returned entry was rejected"],
        ["partial", { error: { code: "failure", message: 'MCP server \'workiq\': {"results":[{"statusCode":400,"error":{"code":"BadRequest","message":"The complete prefix entry was rejected."}},{"statusCode":' } }, "complete prefix entry was rejected"],
        ["missing", {}, "tool did not provide an error reason"],
        ["generic", { error: { code: "failure", message: "failure" } }, "generic failure message"],
        ["privacy", { error: { code: "AccessDenied", message: "Bearer " + "a".repeat(40) } }, "privacy"],
        ["size", { error: { code: "AccessDenied", message: "x".repeat(8193) } }, "saving limit"],
        ["format", { error: { code: "AccessDenied", message: { text: "UNSUPPORTED_OBJECT_TEXT" } } }, "error format"],
        ["legacy", {}, "Failure reason was not saved"],
        ["retrieval", wrapped({ "application/vnd.ms-workiq.retrieval": {
            markdown: "", retrievalHits: [], resultCount: 0, stoppedReason: "error",
        } }), "source did not supply a reason"],
        ["blob", wrapped({ statusCode: 403, sizeBytes: 0, base64Content: "", error: { error: {
            code: "accessDenied", message: "The invented download was denied.",
        } } }), "invented download was denied"],
        ["application", { success: true, result: { isError: true, structuredContent: {
            error: { code: "BadRequest", message: "Application validation rejected the result." },
        } } }, "Application validation rejected"],
        ["nested", { result: { structuredContent: { statusCode: 412, data: null, error: {
            error: { code: "PreconditionFailed", message: "The supplied version is stale." },
        } } } }, "supplied version is stale"],
        ["separate", { error: { code: "failure", message: "The invocation ended with a transport error." },
            result: { structuredContent: { statusCode: 409, error: { code: "Conflict", message: "The result reports a version conflict." } } } },
        "result reports a version conflict"],
        ["completed", { success: true }, null],
        ["unknown", null, null],
    ];
    const now = Date.now() - 60000;
    const event = (id, type, data, offset) => ({ id, type, data, timestamp: new Date(now + offset).toISOString() });
    const source = [event("prompt", "user.message", { content: "Inspect the invented operations and their recorded results." }, 0),
        ...cases.flatMap(([id, data], index) => [
            event("start-" + id, "tool.execution_start", {
                toolCallId: id, toolName: id === "retrieval" ? "workiq-retrieve" : id === "blob" ? "workiq-fetch_blob" : "workiq-fetch",
                arguments: id === "retrieval" ? { query: "Invented notes" } : id === "blob" ? { path: "/me/drive/items/invented/content" }
                    : { entityUrls: id === "returned" ? ["/me/messages", "/me/events"] : ["/me/messages"] },
            }, index * 100 + 1),
            ...(data === null ? [] : [event("end-" + id, "tool.execution_complete", { toolCallId: id, success: false, ...data }, index * 100 + 50)]),
        ])];
    const retained = source.map(event => retainEvent(event, { credentialExclusions: 0 }));
    const records = extractScenarios(retained, { sessionId: randomUUID() }, source[0].timestamp, source.at(-1).timestamp).scenarios;
    delete records[0].toolCalls.find(call => call.toolCallId === "legacy").failureEvidence;
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    const controller = createExportController(context), before = await loadBoardState(context);
    const runtime = await startServer(context, controller, { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin !== new URL(runtime.url).origin) { external.push(route.request().url()); return route.abort(); }
        return route.continue();
    });
    t.after(async () => { await browser.close(); await runtime.close(); for (const fn of cleanup) await fn(); });
    await page.goto(runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    const card = page.locator(".request-card-open");
    for (const [id, , expected] of cases.filter(([, , expected]) => expected)) {
        const index = cases.findIndex(entry => entry[0] === id), reason = card.locator(".request-card-reason").filter({ hasText: new RegExp(`Call #${index + 1}\\b`) });
        await expect(reason).toContainText(expected);
        await expect(reason.locator(".request-card-operation")).toContainText("workiq-");
        if (!["retrieval", "blob"].includes(id)) await expect(reason).toContainText("Requested: /me/messages");
    }
    await card.click();
    for (const [id, , expected] of cases.filter(([, , expected]) => expected)) {
        const call = page.locator(`[data-reader-section=activity] [data-tool-call-id="${id}"]`);
        await expect(call).toContainText(expected);
        await expect(call.locator(".call-heading")).toContainText("workiq-");
    }
    const completed = page.locator('[data-tool-call-id="completed"]');
    await completed.locator(".reader-call-toggle").click();
    await expect(completed).toContainText("source recorded a successful tool completion");
    await expect(completed).toContainText("does not establish answer correctness");
    await expect(page.locator('[data-tool-call-id="unknown"]')).toContainText("no recorded result");
    await page.setViewportSize({ width: 650, height: 1000 });
    assert.ok(await page.locator("#contextSidebarBody").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    const preview = await controller.preview("family-proof", undefined, {
        saveMode: "local", formats: ["html", "json", "markdown"], resultText: true, resultTextKind: "errors",
        reportFocus: { version: 1, preset: "all", outcome: "all", services: [] },
    }, { kind: "all", revision: before.revision });
    assert.equal(preview.snapshot.resultFacts.calls.length, cases.length);
    for (const body of [preview.files["product-report.html"], preview.files["product-report.md"]]) {
        assert.ok(body.includes(`Report call ${cases.length}`));
        for (const text of ["No MCP server was found", "supplied invocation arguments", "recorded permission is missing",
            "second returned entry was rejected", "complete prefix entry was rejected", "invented download was denied",
            "Application validation rejected", "excluded for privacy", "saving limit", "error format", "Failure reason was not saved",
            "invocation ended with a transport error", "result reports a version conflict", "Recorded result error"]) assert.ok(body.includes(text), text);
        assert.doesNotMatch(body, /UNSUPPORTED_OBJECT_TEXT|Bearer|a{40}/);
    }
    assert.deepEqual((await loadBoardState(context)).evidence, before.evidence);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
});

for (const shape of ["sdk", "workiq-single"]) test(`ordinary collection retains ${shape} failure across restart and reopened reader with replies off`, { timeout: 60000 }, async t => {
    const cleanup = [], { root, context } = await privateFixture({ after: fn => cleanup.push(fn) }, []);
    const sourceId = randomUUID(), appDbPath = path.join(root, "data.db"), sessionRoot = path.join(root, "session-state");
    const db = new DatabaseSync(appDbPath);
    db.exec("PRAGMA user_version=156; CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);");
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(sourceId, "Invented failed call", "chat", null, "local");
    await mkdir(path.join(sessionRoot, sourceId), { recursive: true });
    const sourceFile = path.join(sessionRoot, sourceId, "events.jsonl"), now = Date.now() - 5000;
    const event = (id, type, data, ms) => ({ id, type, data, timestamp: new Date(now + ms).toISOString() });
    const message = shape === "sdk" ? "The supplied version is stale. Read the resource again before retrying."
        : "You cannot access the invented item, or the item may not exist.";
    const start = (id, ms) => event("start-" + id, "tool.execution_start", {
        toolName: "workiq-delete_entity", toolCallId: id, arguments: { entityUrl: "/planner/plans/invented-plan" },
    }, ms);
    await writeFile(sourceFile, [
        event("session", "session.start", { sessionId: sourceId, version: 1 }, 0),
        event("prompt", "user.message", { content: "Remove the invented plan." }, 1),
        start("first", 2),
        event("done-first", "tool.execution_complete", { toolCallId: "first", success: true }, 3),
        start("second", 4),
    ].map(value => JSON.stringify(value) + "\n").join(""));
    let collector = await createCollector(context, { timers: false }), runtime, browser;
    t.after(async () => {
        await browser?.close();
        if (runtime) await runtime.close(); else await collector.close();
        db.close(); for (const fn of cleanup) await fn();
    });
    await collector.configure({ appDbPath, sessionRoot, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    await collector.collectNow();
    await collector.close();
    collector = await createCollector(context, { timers: false });
    await appendFile(sourceFile, [
        event("done-second", "tool.execution_complete", { toolCallId: "second", success: false, ...(shape === "sdk" ? {
            error: { code: "failure", message, stack: "EXCLUDED_STACK" },
            result: { structuredContent: { results: [
                { statusCode: 412, error: { code: "PreconditionFailed", message: "Only this returned item has a version conflict.",
                    details: [{ code: "VersionMismatch", message: "Use a current resource version." }] } },
                { statusCode: 200, body: { text: "EXCLUDED_SUCCESS_BODY" } },
            ] } },
        } : { error: { code: "failure", message: `MCP server 'workiq': ${JSON.stringify({
            statusCode: 403, data: null, error: { error: { code: "", message, innerError: { "request-id": "EXCLUDED_REQUEST_ID" } } },
            requestId: "EXCLUDED_ENVELOPE_ID",
        })}` } }) }, 842),
        event("answer", "assistant.message", { content: "EXCLUDED_ASSISTANT_REPLY" }, 843),
    ].map(value => JSON.stringify(value) + "\n").join(""));
    const sourceBefore = await readFile(sourceFile);
    await collector.collectNow();
    const persisted = await loadBoardState(context), record = persisted.evidence[0];
    assert.equal(persisted.personalEvaluation, undefined);
    assert.equal(record.toolCalls[1].failureEvidence.diagnostic.message, message);
    assert.equal(record.toolCalls[1].durationMs, 838);
    assert.equal(record.toolCalls[1].completionEventId, "done-second");
    const index = JSON.parse(await readFile(path.join(context.dataDir, "collector", "index.json"), "utf8"));
    const checkpoint = await readFile(path.join(context.dataDir, "collector", index.fingerprint, sourceId + ".json"), "utf8");
    assert.ok(checkpoint.includes(message));
    assert.doesNotMatch(checkpoint, /EXCLUDED_/);
    assert.doesNotMatch(JSON.stringify(buildSanitizedRecord(record, "a".repeat(64))), /supplied version|Only this returned item|current resource version/);
    assert.ok(!JSON.stringify(buildSanitizedRecord(record, "a".repeat(64))).includes(message));
    await collector.close();
    runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    browser = await chromium.launch();
    const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const page = await browserContext.newPage(), errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    await browserContext.route("**/*", route => {
        if (new URL(route.request().url()).origin !== new URL(runtime.url).origin) { external.push(route.request().url()); return route.abort(); }
        return route.continue();
    });
    await page.goto(runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    const settled = () => page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.locator(".request-card-open").click();
        await settled();
        const call = page.locator('[data-reader-section=activity] [data-tool-call-id="second"]');
        const trigger = call.locator(".reader-call-toggle");
        if (await trigger.count() && await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
        await expect(call.locator(".reader-error-message").filter({ hasText: message })).toBeVisible();
        if (shape === "sdk") {
            await expect(call).toContainText("Only this returned item has a version conflict.");
            await expect(call).toContainText("Use a current resource version.");
        } else {
            await expect(call.locator(".api-result-entry")).toHaveCount(0);
            await expect(call).toContainText("Tool-reported status403");
        }
        await expect(page.locator('[data-reader-section=activity] [data-tool-call-id="first"]')).not.toContainText(message);
        await expect(call).not.toContainText("Error detail not retained");
        await expect(page.locator("#requestContent")).not.toContainText("EXCLUDED_");
        if (process.env.WIRE_FAILURE_PROOFS) {
            await mkdir(process.env.WIRE_FAILURE_PROOFS, { recursive: true });
            await call.locator(".reader-error-message").filter({ hasText: message }).scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(process.env.WIRE_FAILURE_PROOFS, `failure-${shape}-${theme}.png`) });
        }
        await page.locator("#closeContextSidebar").click();
        await settled();
    }
    await page.reload();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.locator(".request-card-open").click();
    await settled();
    const reopened = page.locator('[data-reader-section=activity] [data-tool-call-id="second"] .reader-call-toggle');
    if (await reopened.getAttribute("aria-expanded") !== "true") await reopened.click();
    await expect(page.locator("#requestContent")).toContainText(message);
    await page.setViewportSize({ width: 650, height: 900 });
    await expect(page.locator('[data-tool-call-id="second"] .technical-detail .reader-error-message')).toHaveText(message);
    assert.deepEqual(await readFile(sourceFile), sourceBefore);
    assert.deepEqual((await loadBoardState(context)).evidence, persisted.evidence);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
});
