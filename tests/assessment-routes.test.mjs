import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { privateFixture } from "./helpers.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";

test("synthetic: installed assessment reads, guarded mutation receipts and contract module work on an isolated server", async t => {
    const { context } = await privateFixture(t);
    let runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    t.after(() => runtime.close());
    let origin = runtime.url.slice(0, -1);
    const post = (route, body, capability) => fetch(origin + route, {
        method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...(capability ? { "X-Board-Capability": capability } : {}) },
        body: JSON.stringify(body),
    });
    const a = (await (await post("/api/session", {})).json()).capability;
    const b = (await (await post("/api/session", {})).json()).capability;
    const asset = await fetch(origin + "/assets/assessment-contract.mjs");
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type"), /javascript/);
    assert.match(asset.headers.get("content-security-policy"), /font-src data:/);
    const snapshot = await (await post("/api/snapshot", {}, a)).json();
    assert.equal(snapshot.assessment.catalog[0].status, "retained");
    const interactionRef = snapshot.assessment.catalog[0].interactionRef;
    const detail = await (await post("/api/assessment/detail", { schemaVersion: 1, interactionRef, expectedSourceRevision: snapshot.revision }, a)).json();
    assert.equal(detail.data.interaction.interactionRef, interactionRef);
    const mutation = {
        schemaVersion: 1, mutationRef: `mutation-${randomBytes(16).toString("hex")}`,
        receiptToken: randomBytes(32).toString("hex"),
        expectedSourceRevision: detail.basis.sourceRevision, expectedConsentRevision: 0, policyVersion: 1,
        enabled: false, categories: [], sourceConfigRef: "sourceconfig-" + "a".repeat(32), sourceConfigRevision: 0, confirmed: true,
    };
    const response = await post("/api/assessment/consent/set", mutation, a);
    assert.equal(response.status, 200);
    const receipt = await response.json();
    assert.equal(receipt.phase, "complete");
    assert.equal(receipt.basis.sourceRevision, detail.basis.sourceRevision);
    assert.equal(receipt.basis.overrideRevision, detail.basis.overrideRevision);
    assert.equal(receipt.basis.consentRevision, detail.basis.consentRevision + 1);
    assert.equal((await post("/api/assessment/mutation/status", { schemaVersion: 1, mutationRef: mutation.mutationRef }, b)).status, 403);
    assert.equal((await post("/api/assessment/detail", { schemaVersion: 1, interactionRef, expectedSourceRevision: receipt.basis.sourceRevision + 1 }, a)).status, 409);
    const empty = await (await post("/api/assessment/overview", { schemaVersion: 1, interactionRefs: [], expectedSourceRevision: receipt.basis.sourceRevision }, a)).json();
    assert.deepEqual(empty.data, { interactionRefs: [], metrics: [], assessmentAttempts: [], reviewStatuses: [] });
    await runtime.close();
    runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    origin = runtime.url.slice(0, -1);
    const fresh = (await (await post("/api/session", {})).json()).capability;
    assert.equal((await post("/api/assessment/mutation/status", { schemaVersion: 1, mutationRef: mutation.mutationRef }, fresh)).status, 403);
    const recovered = await post("/api/assessment/mutation/status", { schemaVersion: 1, mutationRef: mutation.mutationRef, receiptToken: mutation.receiptToken }, fresh);
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).phase, "complete");
    assert.equal((await post("/api/assessment/mutation/status", { schemaVersion: 1, mutationRef: mutation.mutationRef, receiptToken: "f".repeat(64) }, fresh)).status, 403);
    assert.equal((await post("/api/assessment/consent/set", mutation, fresh)).status, 403, "A receipt capability never authorizes mutation replay");
});

test("synthetic: read-only status survives a failed post-seal revocation and a real server restart", async t => {
    const { context } = await privateFixture(t);
    const { defaultPersonalEvaluation } = await import("../lib/personal-evaluation.mjs");
    const { updateBoardState } = await import("../lib/store.mjs");
    await updateBoardState(context, state => {
        const personal = defaultPersonalEvaluation();
        personal.source = { available: true, sourceConfigRef: `sourceconfig-${"1".repeat(32)}`, sourceConfigRevision: 1 };
        personal.consent = { ...personal.consent, state: "enabled", revision: 1, categories: ["answer"], sourceConfigRef: personal.source.sourceConfigRef,
            sourceConfigRevision: 1, grantedAt: "2026-10-06T12:00:00.000Z", grantOrigin: "explicit-in-app-setup" };
        state.personalEvaluation = personal;
    });
    let runtime = await startServer(context, createExportController(context), {
        port: 0, collector: { timers: false }, deletion: { afterSeal: () => { throw new Error("synthetic-post-seal-interruption"); } },
    });
    t.after(() => runtime.close());
    let origin = runtime.url.slice(0, -1);
    const post = (route, body, capability) => fetch(origin + route, {
        method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...(capability ? { "X-Board-Capability": capability } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    const owner = (await (await post("/api/session", {})).json()).capability;
    const consent = await (await post("/api/assessment/consent", { schemaVersion: 1 }, owner)).json();
    const input = {
        schemaVersion: 1, mutationRef: `mutation-${randomBytes(16).toString("hex")}`, receiptToken: randomBytes(32).toString("hex"),
        expectedSourceRevision: consent.basis.sourceRevision, expectedConsentRevision: 1, policyVersion: 1,
        enabled: false, categories: [], sourceConfigRef: `sourceconfig-${"1".repeat(32)}`, sourceConfigRevision: 1, confirmed: true,
    };
    assert.equal((await post("/api/assessment/consent/set", input, owner)).status, 500);
    const pending = await (await post("/api/assessment/mutation/status", { schemaVersion: 1, mutationRef: input.mutationRef }, owner)).json();
    assert.equal(pending.phase, "pending");
    assert.equal((await post("/api/snapshot", {}, owner)).status, 503);
    const collection = await (await post("/api/collection/status", {}, owner)).json();
    assert.equal(collection.assessment.pendingCleanup, true);
    await runtime.close();
    runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    origin = runtime.url.slice(0, -1);
    const fresh = (await (await post("/api/session", {})).json()).capability;
    const recovered = await (await post("/api/assessment/mutation/status", {
        schemaVersion: 1, mutationRef: input.mutationRef, receiptToken: input.receiptToken,
    }, fresh)).json();
    assert.equal(recovered.phase, "complete");
    assert.equal(recovered.operationId, pending.operationId);
    assert.equal(recovered.data.consent.state, "revoked");
    assert.equal((await post("/api/assessment/consent/set", input, fresh)).status, 403);
});
