import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { privateFixture, chooseTheme } from "./helpers.mjs";
import { createCollector } from "../lib/collector.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController, buildSanitizedRecord } from "../lib/export.mjs";

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
