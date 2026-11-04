import test from "node:test";
import assert from "node:assert/strict";
import { microsoftProfileView } from "../lib/microsoft-profile.mjs";
import { projectNativeSourceResponse } from "../lib/microsoft-chat-capture.mjs";
import { createMicrosoftNativeReadTransport } from "../lib/microsoft-native-transport.mjs";
import { createMicrosoftSession } from "../lib/microsoft-session.mjs";
import { createNativePersistence } from "../lib/native-persistence.mjs";
import { createNativeRuntimeAccess } from "../lib/runtime-access.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture } from "./helpers.mjs";
import { randomUUID } from "node:crypto";

test("Microsoft presentation uses only a genuine matched principal observation and never an expectation fallback", () => {
    const project = label => projectNativeSourceResponse({
        kind: "principal", mime: "application/json", expectedAccount: "expected@example.invalid",
        bytes: Buffer.from(JSON.stringify({ store: { accountInfo: {
            accountType: "AAD", environment: "prod", tenantId: "synthetic-tenant", objectId: "synthetic-subject",
        }, identity: { userPrincipalName: label } } })),
    });

    const matching = project("Expected@Example.Invalid");
    assert.deepEqual(matching.presentation, { source: "microsoft-native-principal", email: "Expected@Example.Invalid" });
    assert.equal(project("different@example.invalid").presentation, undefined);
    assert.equal(project(undefined).presentation, undefined);
    const view = microsoftProfileView({ ...matching.presentation, generation: 4, observedAt: "2026-10-27T00:00:00Z" }, 100000);
    assert.equal(view.provider, "microsoft");
    assert.equal(view.email.value, "Expected@Example.Invalid");
    assert.equal(view.identity.state, "verified");
    assert.equal(view.identity.expiresAt, 115000);
    assert.equal(view.displayName.value, null); assert.equal(view.avatar.url, null);
    assert.doesNotMatch(JSON.stringify(view), /synthetic-tenant|synthetic-subject|expectedAccount/);
    assert.equal(microsoftProfileView(null, 100000).email.value, null);
    assert.throws(() => microsoftProfileView({ ...matching.presentation, generation: 4 }), /presentation/i);
});

test("observed presentation does not alter canonical account identity and stops with its verification owner", async () => {
    const proof = { tenantId: "tenant", subjectId: "subject", knownAccountMatched: true,
        evidence: { kind: "native-account-metadata", issuer: "https://copilot.cloud.microsoft",
            namespace: "m365.accountInfo.objectId", realm: "prod", observedAt: new Date().toISOString() } };
    const make = presentation => createMicrosoftNativeReadTransport({
        async open() {}, async stop() { return { processExited: true, profileReleased: true }; },
        async verifyAccount() { return { ...proof, ...(presentation ? { presentation } : {}) }; },
    });
    const plain = make(), profile = make({ source: "microsoft-native-principal", email: "Observed@example.invalid" });
    const operation = { ownerId: "synthetic-owner", generation: 7 };
    await plain.open(operation); await profile.open(operation);
    const a = await plain.verify(operation), b = await profile.verify(operation);
    assert.deepEqual(a, b);
    const lease = { kind: "microsoft-retained", partition: a.partition, generation: 7 };
    const identity = profile.accountFor(lease);
    assert.deepEqual(identity.account, plain.accountFor(lease).account);
    assert.equal(identity.presentation.email, "Observed@example.invalid");
    assert.equal(identity.presentation.generation, 7);
    await profile.stop(operation);
    assert.throws(() => profile.accountFor(lease), { code: "lease-invalid" });
    const malformed = make({ source: "expected-account", email: "typed@example.invalid" });
    await malformed.open(operation);
    await assert.rejects(malformed.verify(operation), { code: "account-metadata-unavailable" });
});

test("Microsoft profile HTTP requires panel and genuine current retained lease, survives Pause and clears at logout", async t => {
    const cleanup = [], { context } = await privateFixture({ after: work => cleanup.push(work) });
    let lifecycle, persistence, access, runtime;
    t.after(async () => {
        await runtime?.close(); access?.close(); persistence?.close(); await lifecycle?.close();
        for (const work of cleanup.reverse()) await work();
    });
    let verifications = 0;
    const transport = createMicrosoftNativeReadTransport({
        async open() {}, async stop() { return { processExited: true, profileReleased: true }; },
        async verifyAccount() {
            verifications++;
            return { tenantId: "private-tenant", subjectId: "private-subject", knownAccountMatched: true,
                presentation: { source: "microsoft-native-principal", email: "Observed@Example.Invalid" },
                evidence: { kind: "native-account-metadata", issuer: "https://copilot.cloud.microsoft",
                    namespace: "m365.accountInfo.objectId", realm: "prod", observedAt: new Date().toISOString() } };
        },
    });
    lifecycle = await createMicrosoftSession(context, { transport, collection: { paused: true, windowDays: 30 },
        sourceAware: true, globalCollection: null });
    persistence = await createNativePersistence(context, { lifecycle, transport, preAccount: "metadata-only", configurationIntents: true });
    access = await createNativeRuntimeAccess(context, { lifecycle, nativePersistence: persistence, sourceAware: true,
        nativeConnection: true, nativeAcquisition: false, acquireNative: async () => assert.fail("Profile reads must not acquire activity.") });
    runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false }, access,
        githubProfile: { fetch: () => assert.fail("Microsoft identity cannot fall back to GitHub.") } });
    const origin = new URL(runtime.url).origin;
    const request = async (route, input, capability) => {
        const response = await fetch(origin + route, { method: input === undefined ? "GET" : "POST",
            headers: { Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1", ...(capability ? { "X-Board-Capability": capability } : {}) },
            ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
        return { status: response.status, body: await response.json() };
    };
    const capability = (await request("/api/session", {})).body.capability;
    const profile = () => request("/api/profile/microsoft", undefined, capability);
    const command = async action => {
        const response = await request("/api/access/command", { schemaVersion: 1, action, operationId: randomUUID(),
            generation: (await lifecycle.status()).generation }, capability);
        assert.equal(response.status, 200); return response.body;
    };
    assert.equal((await request("/api/profile/microsoft")).status, 403);
    assert.equal((await profile()).status, 403);
    await command("wire-sign-in");
    assert.equal((await profile()).body.identity.state, "unavailable");
    assert.equal(verifications, 0);
    await command("microsoft-connect");
    const result = await profile();
    assert.equal(result.status, 200); assert.equal(result.body.email.value, "Observed@Example.Invalid");
    assert.equal(result.body.displayName.value, null); assert.equal(result.body.avatar.url, null);
    assert.doesNotMatch(JSON.stringify(result.body), /private-tenant|private-subject|partition|expectedAccount/);
    const lease = await lifecycle.lease("microsoft-retained");
    await assert.rejects(persistence.readAccountPresentation({ ...lease }), { code: "lease-invalid" });
    await lifecycle.updateCollection({ paused: true, windowDays: 30 });
    assert.equal((await profile()).body.email.value, "Observed@Example.Invalid");
    assert.equal(verifications, 1);
    assert.doesNotMatch(JSON.stringify(await loadBoardState(context)), /Observed@Example\.Invalid/);
    await command("wire-sign-out");
    assert.equal((await profile()).status, 403);
    await assert.rejects(persistence.readAccountPresentation(lease), { code: "lease-invalid" });
    await command("wire-sign-in");
    assert.equal((await profile()).body.identity.state, "unavailable");
    assert.equal(verifications, 1, "Local Login and profile reads cannot authenticate Microsoft.");
});
