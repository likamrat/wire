import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { replaceEvidence, moveCard } from "../lib/store.mjs";

test("a second browser or renewed session cannot confirm another owner's preview", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "workiq-owner-test-"));
    const context = { dataDir, sessionId: null };
    let runtime;
    try {
        const scenario = {
            scenarioId: "synthetic-owner-test", title: "Synthetic owner-isolation fixture",
            sourceSessionId: "synthetic-source", capturedAt: "2026-10-01T12:00:00.000Z",
            sourceHost: "copilot-app", sample: false, workloadKind: "recorded-history",
            userPrompt: { text: "Synthetic request for fixture testing only.", status: "full", provenance: "human-authored" },
            followUpPrompts: [],
            toolCalls: [{
                tool: "workiq-fetch", toolCallId: "synthetic-call", startEventId: "synthetic-start",
                requestArgs: { entityUrls: ["/me/calendarView"] }, requestedApiPath: "/me/calendarView",
                toolSucceeded: true, reportedOutcome: "succeeded", observedGraphHttp: false,
                apiResults: [{ index: 0, statusCode: 200, evidenceLevel: "intermediary-reported" }],
            }],
        };
        await replaceEvidence(context, () => ({ records: [scenario], importCoverage: { counts: {}, roster: [] } }));
        await moveCard(context, scenario.scenarioId, "reviewing");
        await moveCard(context, scenario.scenarioId, "ready_to_export");
        runtime = await startServer(context, createExportController(context), { port: 0 });
        const origin = runtime.url.slice(0, -1);
        const post = (route, body, capability) => fetch(origin + route, {
            method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...(capability ? { "X-Board-Capability": capability } : {}) },
            body: JSON.stringify(body),
        });
        const a = (await (await post("/api/session", {})).json()).capability;
        const b = (await (await post("/api/session", {})).json()).capability;
        const previewResponse = await post("/api/preview", { scenarioIds: [scenario.scenarioId] }, a);
        assert.equal(previewResponse.status, 200);
        const preview = await previewResponse.json();
        assert.equal(preview.privacy.reviewerConfirmed, false);
        const confirmation = { previewId: preview.previewId, confirmed: true };
        assert.equal((await post("/api/export", confirmation, b)).status, 409, "Different owner cannot borrow a preview");
        assert.equal((await post("/api/export", confirmation, a)).status, 428, "Original owner still needs disclosure review");
        assert.equal((await post("/api/session/release", {}, a)).status, 200);
        const renewed = (await (await post("/api/session", {})).json()).capability;
        assert.equal((await post("/api/export", confirmation, renewed)).status, 409, "Renewal cannot carry prior disclosure authority");
        assert.deepEqual(await readdir(path.join(dataDir, "exports")), []);
        // No /api/privacy-review attestation is submitted, even for this synthetic fixture.
    } finally {
        if (runtime) await runtime.close();
        await rm(dataDir, { recursive: true });
    }
});
