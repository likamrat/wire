import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { projectCoworkMembership, coworkConversationReference, coworkParentReferences } from "../lib/native-cowork-membership.mjs";
import { compareNativeIdentityHeaders, compareNativeReadHeaders, installNativeChatCapture } from "../lib/microsoft-chat-capture.mjs";
import { createNativeBackfill, validateNativeBackfill } from "../lib/native-backfill-state.mjs";

const principal = { knownAccountMatched: true, namespace: "m365.accountInfo.objectId", realm: "prod",
    tenantId: "tenant", subjectId: "subject" };
const cid = session => `tenant:subject:${session}`;

test("Cowork metadata projects original parent/log identities without reading configuration or synthesizing execution IDs", () => {
    const secret = () => { throw Error("Private configuration must not be inspected"); };
    const source = { conversation_id: cid("parent"), execution_count: 100, version: 3,
        recent_executions: [{ target_conversation_id: cid("run:with:colons"), conversation_id: cid("parent"),
            get executed_at() { return secret(); }, get id() { return secret(); } }],
        get instructions() { return secret(); }, get callback_url() { return secret(); }, get secret_header() { return secret(); } };
    const projected = projectCoworkMembership(source, "cowork-schedule");
    const evidence = coworkParentReferences({ kind: "scheduled", id: cid("parent") }, projected, principal);
    assert.deepEqual(evidence.references, [{ conversationId: cid("parent"), sessionId: "parent" },
        { conversationId: cid("run:with:colons"), sessionId: "run:with:colons" }]);
    assert.equal(evidence.logAvailable, true);
    assert.equal(Object.hasOwn(evidence, "exhausted"), false, "A recent log and its count are not an exhaustion witness.");
    assert.equal(Object.hasOwn(projected.recent_executions[0], "executed_at"), false);
    const browserProjection = vm.runInNewContext(`(${projectCoworkMembership.toString()})`);
    assert.equal(JSON.stringify(browserProjection(source, "cowork-schedule")), JSON.stringify(projected));
});

test("Cowork membership keeps unavailable and unresolved references distinct from empty and rejects foreign accounts", () => {
    const parent = { kind: "event", id: "trigger", owner_conversation_id: cid("parent") };
    assert.equal(projectCoworkMembership(null, "cowork-trigger"), null);
    assert.deepEqual(coworkParentReferences(parent, null, principal), {
        references: [{ conversationId: cid("parent"), sessionId: "parent" }], logAvailable: false, unresolved: 1 });
    const detail = projectCoworkMembership({ id: "trigger", recent_fires: [{ execution_mode: "create_new" }] }, "cowork-trigger");
    assert.equal(coworkParentReferences(parent, detail, principal).unresolved, 1);
    assert.throws(() => coworkParentReferences(parent, { id: "other", recent_fires: [] }, principal),
        { code: "NATIVE_SOURCE_ASSOCIATION_FAILED" });
    for (const value of ["foreign:subject:run", "tenant:other:run", "tenant:subject:", "tenant:subject:../run"]) {
        assert.throws(() => coworkConversationReference(value, principal), { code: "NATIVE_COWORK_MEMBERSHIP_ACCOUNT_UNQUALIFIED" });
    }
    assert.throws(() => coworkParentReferences({ kind: "unknown", id: "parent" }, {}, principal),
        { code: "NATIVE_COWORK_MEMBERSHIP_UNQUALIFIED" });
});

test("ongoing original identity headers compare to the verified read-lease account without renewing first-Connect evidence", () => {
    const seen = [], read = key => { seen.push(key); return key === "x-user-id" ? "subject" : "tenant"; };
    const stale = { ...principal, observedAt: "2000-01-01T00:00:00.000Z" };
    assert.equal(compareNativeIdentityHeaders(read, stale).reason, "fresh-principal-required");
    assert.deepEqual(seen, []);
    const identity = { namespace: principal.namespace, realm: "prod",
        account: { tenantId: "tenant", subjectId: "subject", verification: "verified" } };
    assert.deepEqual(compareNativeReadHeaders(read, identity), { state: "matched" });
    assert.deepEqual(seen, ["x-user-id", "x-tenant-id"]);
    assert.equal(compareNativeReadHeaders(() => "foreign", identity).reason, "native-identity-header-mismatch");
    assert.equal(compareNativeReadHeaders(() => null, identity).reason, "native-identity-header-missing");
    assert.equal(compareNativeReadHeaders(read, { ...identity, account: null }).reason, "verified-owner-required");
    assert.equal(compareNativeReadHeaders(read, { ...identity, namespace: "legacy" }).reason, "verified-owner-required");
});

test("Cowork round-robin checkpoints survive only the existing account/settings/deletion backfill scope", () => {
    const state = createNativeBackfill("a".repeat(64), 30, ["cowork"], 1);
    state.sources[0].coworkCursor = { parentAfter: "b".repeat(64), referenceAfter: "c".repeat(64) };
    assert.deepEqual(createNativeBackfill(state.accountRef, 30, ["cowork"], 1, state).sources[0].coworkCursor,
        state.sources[0].coworkCursor);
    assert.equal(createNativeBackfill(state.accountRef, 30, ["cowork"], 1, state, Date.now(), 1).sources[0].coworkCursor, undefined);
    const invalid = structuredClone(state);
    invalid.sources[0].coworkCursor.parentAfter = "private-original-id";
    assert.throws(() => validateNativeBackfill(invalid), { code: "NATIVE_BACKFILL_INVALID" });
});

test("native phase reset waits for clone projection and binding acknowledgement without changing the caller response", async t => {
    const url = "https://fixture.gateway.prod.island.powerapps.com/v1/event-triggers/trigger";
    const response = new Response(JSON.stringify({ id: "trigger", recent_fires: [], callback_url: "PRIVATE_CALLBACK",
        secret_header: "PRIVATE_SECRET" }), { headers: { "content-type": "application/json" } });
    Object.defineProperty(response, "url", { value: url });
    const delivered = Promise.withResolvers(), accepted = Promise.withResolvers();
    t.after(() => accepted.resolve());
    const window = { fetch: async () => response, binding: async source => {
        delivered.resolve(source);
        await accepted.promise;
    } };
    const context = vm.createContext({ window, location: { origin: "https://m365.cloud.microsoft", pathname: "/not-bootstrap",
        href: "https://m365.cloud.microsoft/not-bootstrap" }, URL, TextEncoder, TextDecoder, crypto: webcrypto,
    setTimeout, clearTimeout, console });
    vm.runInContext(`(${installNativeChatCapture.toString()})(${JSON.stringify({
        binding: "binding", nativeHistory: { coworkMembership: true, resetBinding: "reset" },
    })},null,${projectCoworkMembership.toString()})`, context);
    assert.equal(await window.fetch(url), response);
    const source = await delivered.promise;
    assert.equal(source.state, "complete");
    assert.equal(source.kind, "cowork-trigger");
    assert.equal(JSON.stringify(source.projected), JSON.stringify({ id: "trigger", recent_fires: [] }));
    assert.doesNotMatch(JSON.stringify(source), /PRIVATE_CALLBACK|PRIVATE_SECRET/);
    assert.equal(window.reset(), false, "HTTP completion alone cannot retire a pending original projection.");
    accepted.resolve();
    await setImmediate();
    assert.equal(window.reset(), true);
    assert.equal((await response.json()).secret_header, "PRIVATE_SECRET", "The native caller still receives its unchanged original response.");
});
