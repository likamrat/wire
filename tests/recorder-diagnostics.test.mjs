import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRecorderDiagnostics } from "../lib/recorder-diagnostics.mjs";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture } from "./helpers.mjs";

test("recorder intents deduplicate pending/completed attempts and persist across service recreation without replay", async t => {
    const { context } = await privateFixture(t);
    let sent = 0, release;
    const options = { testTransport: () => { sent++; return new Promise(resolve => { release = () => resolve(new Response("fixture", { status: 503 })); }); } };
    const service = createRecorderDiagnostics(context, options);
    const attemptId = randomUUID(), input = { confirmed: true, attemptId };
    assert.deepEqual(await service.status(), { attempt: null });
    await assert.rejects(readdir(path.join(context.dataDir, "recorder-attempts")), { code: "ENOENT" }, "Reading status does not create files");
    const [a, b, c] = await Promise.all([service.start(input), service.start(input), service.start({ ...input, attemptId: randomUUID() })]);
    assert.equal(a.attempt.phase, "pending");
    assert.equal(b.attempt.attemptId, attemptId);
    assert.equal(c.attempt.attemptId, attemptId);
    // The accepted intent is durable before the async recorder dispatch.
    while (!release) await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent, 1);
    release();
    await service.close();
    const result = (await service.status(attemptId)).attempt;
    assert.equal(result.phase, "http-error");
    assert.equal(result.status, 503);
    assert.equal(result.recordSaved, true);
    assert.equal(result.evidenceSaved, false);
    assert.equal(result.synthetic, true);
    assert.deepEqual((await service.start(input)).attempt, result);
    const recreated = createRecorderDiagnostics(context, { testTransport: () => { throw new Error("MUST NOT REPLAY"); } });
    assert.deepEqual((await recreated.status()).attempt, result);
    assert.deepEqual((await recreated.start(input)).attempt, result);
    assert.equal(sent, 1);
});

test("an interrupted durable intent stays uncertain and never resumes its mutation", async t => {
    const { context } = await privateFixture(t);
    const attemptId = randomUUID(), startedAt = new Date().toISOString();
    const directory = path.join(context.dataDir, "recorder-attempts");
    await mkdir(directory);
    await writeFile(path.join(directory, `${Date.now()}-${attemptId}.attempt.json`), JSON.stringify({ attemptId, startedAt, phase: "pending" }));
    const service = createRecorderDiagnostics(context, { testTransport: () => { throw new Error("MUST NOT DISPATCH"); } });
    assert.equal((await service.status()).attempt.phase, "interrupted");
    assert.equal((await service.start({ attemptId, confirmed: true })).attempt.phase, "interrupted");
    await service.close();
});

test("final outcome persistence errors cannot claim a saved diagnostic", async t => {
    const { context } = await privateFixture(t);
    const before = await loadBoardState(context);
    let sent = 0;
    const service = createRecorderDiagnostics(context, {
        testTransport: async () => {
            sent++;
            const directory = path.join(context.dataDir, "recorder-attempts");
            const intent = (await readdir(directory)).find(name => name.endsWith(".attempt.json"));
            await mkdir(path.join(directory, intent.replace(".attempt.json", ".result.json")));
            return new Response("fixture", { status: 200 });
        },
    });
    const { attempt } = await service.start({ confirmed: true, attemptId: randomUUID() });
    await service.close();
    const result = (await service.status(attempt.attemptId)).attempt;
    assert.equal(result.phase, "save-error");
    assert.equal(result.recordSaved, true);
    assert.equal(result.outcomeSaved, false);
    assert.equal(sent, 1);
    const after = await loadBoardState(context);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.cards, before.cards);
});

test("recorder file persistence failure retains failure outcome without indexing unsaved evidence", async t => {
    const { context } = await privateFixture(t);
    const before = await loadBoardState(context);
    const service = createRecorderDiagnostics(context, {
        testTransport: async () => {
            const directory = path.join(context.dataDir, "http-records");
            await rename(directory, path.join(context.dataDir, "fixture-original-http-records"));
            await writeFile(directory, "fixture blocking persistence");
            return new Response("fixture", { status: 200 });
        },
    });
    const { attempt } = await service.start({ confirmed: true, attemptId: randomUUID() });
    await service.close();
    const result = (await service.status(attempt.attemptId)).attempt;
    assert.equal(result.phase, "save-error");
    assert.equal(result.status, 200);
    assert.equal(result.recordSaved, false);
    assert.equal(result.evidenceSaved, false);
    assert.deepEqual((await loadBoardState(context)).evidence, before.evidence);
});

test("record HTTP route requires capability and identity, accepts promptly, and exposes read-only status", async t => {
    const { context } = await privateFixture(t);
    let release, sent = 0;
    const runtime = await startServer(context, createExportController(context), {
        port: 0, collector: { timers: false }, recorderDiagnostics: {
            testTransport: () => { sent++; return new Promise(resolve => { release = () => resolve(new Response("fixture", { status: 200 })); }); },
        },
    });
    t.after(async () => { release?.(); if (runtime.server.listening) await runtime.close(); });
    const origin = runtime.url.slice(0, -1);
    const post = (route, body, capability) => fetch(origin + route, {
        method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1", ...(capability ? { "X-Board-Capability": capability } : {}) },
        body: JSON.stringify(body),
    });
    const input = { confirmed: true, attemptId: randomUUID() };
    assert.equal((await post("/api/record", input)).status, 403);
    const { capability } = await (await post("/api/session", {})).json();
    assert.equal((await post("/api/record", { confirmed: true }, capability)).status, 400);
    assert.equal((await post("/api/record", { ...input, confirmed: false }, capability)).status, 400);
    assert.equal((await post("/api/record/status", { attemptId: "../invalid" }, capability)).status, 400);
    const response = await post("/api/record", input, capability);
    const accepted = await response.json();
    assert.equal(response.status, 200);
    assert.equal(accepted.attempt.phase, "pending");
    assert.equal(accepted.attempt.attemptId, input.attemptId);
    assert.equal((await (await post("/api/record/status", { attemptId: input.attemptId }, capability)).json()).attempt.phase, "pending");
    while (!release) await new Promise(resolve => setImmediate(resolve));
    release();
    await runtime.close();
    const service = createRecorderDiagnostics(context);
    const result = (await service.status(input.attemptId)).attempt;
    assert.equal(result.phase, "succeeded");
    assert.equal(sent, 1);
    const record = JSON.parse(await readFile(path.join(context.dataDir, "http-records", `${result.recordId}.json`), "utf8"));
    assert.equal(record.synthetic, true);
    assert.equal(record.observedGraphHttp, false);
});
