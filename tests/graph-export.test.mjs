import test from "node:test";
import assert from "node:assert/strict";
import { buildSanitizedBundle } from "../lib/export.mjs";
import { fixture } from "./helpers.mjs";

function graphScenario() {
    return {
        ...fixture("synthetic-graph-scenario"),
        toolCalls: [],
        graphActivities: [{
            activityId: "synthetic-graph-activity", sourceSessionId: "test-session",
            scenarioId: "synthetic-graph-scenario", toolCallId: "synthetic-shell-call",
            startEventId: "synthetic-shell-start", completionEventId: "synthetic-shell-end",
            startedAt: "2026-09-30T12:00:00.000Z", tool: "shell",
            evidenceLevel: "requested-direct-graph",
            endpoint: { id: "synthetic-endpoint", label: "GET v1.0 /me/messages", path: "/me/messages", method: "GET", apiVersion: "v1.0", queryShape: ["$select"] },
            workload: "Mail", method: "GET", httpStatus: null, statusBasis: "none",
            requestCount: null, countUnit: "recorded-request-site", confidence: "high",
            synthetic: false, sourceKind: "inline-command", requestBasis: "request-command",
            fallback: { association: "none", precedingWorkIqCallIds: [], causeProven: false },
            evidenceRefs: [{ eventId: "synthetic-shell-start", role: "request" }],
        }],
    };
}

test("graph-only report scans the original prompt and projects separately attributed request evidence", async () => {
    const bundle = await buildSanitizedBundle([graphScenario()], "a".repeat(64), { promptMode: "none", formats: ["markdown"] });
    assert.equal(bundle.privacy.allSelectedFieldsScanned, true);
    assert.equal(bundle.privacy.originatingPrompts, 1);
    assert.equal(bundle.privacy.toolArgumentObjects, 0);
    const projected = bundle.records[0];
    assert.equal(projected.toolCalls.length, 0);
    assert.equal(projected.graphActivities.length, 1);
    assert.equal(projected.graphActivities[0].httpStatus, null);
    assert.equal(projected.graphActivities[0].evidenceLevel, "requested-direct-graph");
    assert.notEqual(projected.graphActivities[0].activityId, "synthetic-graph-activity");
    assert.doesNotMatch(JSON.stringify(bundle.files), /SYNTHETIC_PRIVATE|synthetic-shell-call|synthetic-shell-start|test-session|2026-09-30/);
    assert.match(bundle.files["product-report.md"], /Graph request sites/i);
});

test("graph report discloses partial prompts and rejects unsupported graph schemas", async () => {
    const missing = graphScenario();
    missing.userPrompt.status = "partial";
    const partial = await buildSanitizedBundle([missing], "a".repeat(64));
    assert.equal(partial.snapshot.promptCoverage.partial, 1);
    const unknown = graphScenario();
    unknown.graphActivities[0].evidenceLevel = "assumed-success";
    await assert.rejects(buildSanitizedBundle([unknown], "a".repeat(64)), /graph|schema|unsupported/i);
});
