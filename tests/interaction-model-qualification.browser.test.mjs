import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { extractScenarios } from "../lib/history.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture } from "./helpers.mjs";
import { streamPanel } from "./live-search-fixture.mjs";

test("explicit guarded model qualification updates the exact interaction, call and reader without capturing replies", async t => {
    const id = randomUUID(), now = Date.now() - 5000;
    const event = (type, data, ms, id) => ({ id, type, timestamp: new Date(now + ms).toISOString(), data });
    const events = [
        event("session.start", { sessionId: id, version: 1 }, 0, "startup"),
        event("user.message", { messageId: "logical-prompt", content: "Invented original model request", source: "user" }, 1, "prompt"),
        event("tool.execution_start", { toolName: "workiq-fetch", toolCallId: "call",
            arguments: { entityUrls: ["/me/messages"] }, model: "tool-only-hint" }, 10, "call-start"),
        event("assistant.message", { originatingMessageId: "logical-prompt", apiCallId: "original-api-call", turnId: "turn",
            model: "original-model", phase: "final_answer", content: "PRIVATE_RESPONSE", toolRequests: [] }, 100, "response"),
        event("assistant.turn_end", { turnId: "turn" }, 101, "end"),
    ];
    const records = extractScenarios(events, { sessionId: id, name: "Invented original model history" },
        events[0].timestamp, events.at(-1).timestamp).scenarios;
    delete records[0].originalModelEvidence;
    const cleanup = [];
    const { root, context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    const sessionRoot = path.join(root, "session-state"), appDbPath = path.join(root, "data.db");
    await mkdir(path.join(sessionRoot, id), { recursive: true });
    await writeFile(path.join(sessionRoot, id, "events.jsonl"), events.map(event => JSON.stringify(event) + "\n").join(""));
    const db = new DatabaseSync(appDbPath);
    db.exec(`PRAGMA user_version=156;
        CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT);
        CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
        CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);`);
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(id, "Invented original model history", "chat", null, "local");
    let providers = 0, runtime, browser, searchPanel;
    const commits = [];
    t.after(async () => {
        await searchPanel?.close(); await browser?.close(); await runtime?.close(); db.close();
        for (const fn of cleanup) await fn();
        assert.equal(providers, 0);
    });
    runtime = await startServer(context, createExportController(context), {
        port: 0, collector: { timers: false, onCommitted: (check, change) => commits.push({ check, change }) },
        search: { modelDirectory: path.join(root, "not-provisioned"), heartbeatMs: 60000 },
        evaluation: { evaluatorFactory: () => { providers++; throw Error("No provider in model metadata proof"); } },
    });
    await runtime.collector.configure({ appDbPath, sessionRoot, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    await runtime.collector.setEnabled(true);
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => new URL(route.request().url()).origin === new URL(runtime.url).origin
        ? route.continue() : route.abort());
    await page.goto(runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    const card = page.locator(`.request-row[data-view-key="request:${records[0].scenarioId}"]`);
    const fact = (card, label) => card.locator(".activity-card-facts>div").filter({
        has: page.locator("dt").filter({ hasText: new RegExp(`^${label}:$`) }),
    });
    await expect(fact(card, "Model").locator("dd")).toHaveText("Not verified (tool metadata only)");
    const before = await loadBoardState(context), origin = new URL(runtime.url).origin;
    const input = { operationId: randomUUID(), scenarioIds: [records[0].scenarioId], expectedSourceRevision: before.evidenceRevision };
    const headers = { Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1" };
    const endpoint = origin + "/api/collection/models/qualify";
    const unauthorized = await page.request.post(endpoint, { headers, data: input });
    assert.equal(unauthorized.status(), 403);
    const session = await page.request.post(origin + "/api/session", { headers, data: {} });
    headers["X-Board-Capability"] = (await session.json()).capability;
    const foreign = await page.request.post(endpoint, { headers: { ...headers, Origin: "https://invalid.example" }, data: input });
    assert.equal(foreign.status(), 403);
    searchPanel = await streamPanel(runtime);
    await searchPanel.api("/api/search/query", { query: "workiq-fetch", requestId: 1 });
    const found = await searchPanel.wait(event => event.event === "results" && event.requestId === 1);
    assert.ok(found.matches.receipt.indexId);
    assert.ok(found.matches.hits.length);
    const opened = { id: found.matches.hits[0].id, receipt: found.matches.receipt, openId: 1 };
    assert.equal((await searchPanel.api("/api/search/open", opened)).code, 200);
    const result = await runtime.collector.qualifyInteractionModels(input);
    assert.equal(result.applied, 1);
    assert.equal((await searchPanel.api("/api/search/status")).body.indexId, null,
        "The direct collector commit must fence a ready index without an HTTP mutation wrapper or later heartbeat/source check.");
    assert.equal((await searchPanel.api("/api/search/open", { ...opened, openId: 2 })).code, 409);
    assert.equal(commits.length, 1);
    assert.equal(commits[0].change.kind, "model-metadata");
    await searchPanel.api("/api/search/query", { query: "workiq-fetch", requestId: 2 });
    const fresh = await searchPanel.wait(event => event.event === "results" && event.requestId === 2);
    assert.notEqual(fresh.matches.receipt.indexId, found.matches.receipt.indexId);
    const qualified = await page.request.post(endpoint, { headers, data: input });
    assert.equal(qualified.status(), 200);
    assert.deepEqual(await qualified.json(), result);
    assert.equal((await searchPanel.api("/api/search/status")).body.indexId, fresh.matches.receipt.indexId,
        "A successful receipt replay must not enter the generic mutation fence.");
    const canvasReplay = await page.request.post(origin + "/api/canvas", {
        headers, data: { action: "qualify_interaction_models", input },
    });
    assert.deepEqual(await canvasReplay.json(), result);
    assert.equal((await searchPanel.api("/api/search/status")).body.indexId, fresh.matches.receipt.indexId);
    const beforeNoOp = await loadBoardState(context);
    const noOp = await page.request.post(endpoint, { headers, data: { ...input, operationId: randomUUID(),
        expectedSourceRevision: beforeNoOp.evidenceRevision } });
    assert.equal((await noOp.json()).applied, 0);
    assert.equal((await loadBoardState(context)).revision, beforeNoOp.revision);
    assert.equal((await searchPanel.api("/api/search/status")).body.indexId, fresh.matches.receipt.indexId);
    assert.equal(commits.length, 1, "Only applied model metadata emits a commit signal.");
    await expect(fact(card, "Model").locator("dd")).toHaveText("original-model", { timeout: 15000 });
    await expect(card.locator(".response-timing data")).toHaveAttribute("value", "99");
    await page.locator('[data-analyze-mode="calls"]').click();
    const call = page.locator(".matched-action");
    await expect(fact(call, "Interaction model").locator("dd")).toHaveText("original-model");
    await call.getByRole("link", { name: "Open exact call in context" }).click();
    await expect(page.locator(".request-original .interaction-model-fact dd")).toHaveText("original-model");
    await expect(page.locator(".request-original")).toContainText("Invented original model request");
    await expect(page.locator("body")).not.toContainText("PRIVATE_RESPONSE");
    const after = await loadBoardState(context);
    assert.deepEqual(after.evidence[0].responseTiming, before.evidence[0].responseTiming);
    assert.deepEqual(after.evidence[0].toolCalls, before.evidence[0].toolCalls);
    assert.deepEqual(after.personalEvaluation, before.personalEvaluation);
    assert.deepEqual(errors, []);
});
