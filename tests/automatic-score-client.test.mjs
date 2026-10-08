import test from "node:test";
import assert from "node:assert/strict";
import { createAutomaticScoreClient } from "../web/automatic-score-client.mjs";

const key = "wire.automaticScore.pending";
const packet = () => ({
    schemaVersion: 1, mutationRef: "mutation-" + "a".repeat(32), receiptToken: "b".repeat(64),
    chatRefs: ["synthetic-chat"], maxCalls: 2, maxAiCredits: 1, confirmed: true,
});
function storage() {
    const values = new Map();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
const result = (input, phase = "complete") => ({ schemaVersion: 1, mutationRef: input.mutationRef, phase });

test("automatic approval has no eager request and persists only a minimal receipt before sending", async () => {
    const saved = storage(), calls = [];
    const client = createAutomaticScoreClient({ storage: saved, api: async (route, input) => {
        calls.push(route);
        const receipt = JSON.parse(saved.getItem(key));
        assert.deepEqual(Object.keys(receipt).sort(), ["kind", "mutationRef", "receiptToken", "schemaVersion"]);
        assert.equal(receipt.mutationRef, input.mutationRef);
        assert.equal(receipt.kind, "approve");
        return result(input);
    } });
    assert.deepEqual(calls, []);
    await client.submit("approve", packet());
    assert.deepEqual(calls, ["/api/evaluation/automatic/approve"]);
    assert.equal(client.snapshot().phase, "complete");
    assert.equal(saved.getItem(key), null);
});

test("unavailable or malformed receipt storage blocks dispatch without guessing a new operation", async () => {
    let calls = 0;
    const broken = storage();
    broken.setItem = () => { throw new Error("Synthetic storage failure"); };
    const client = createAutomaticScoreClient({ storage: broken, api: async () => { calls++; } });
    await assert.rejects(client.submit("approve", packet()), /Nothing was sent/);
    const corrupt = storage();
    corrupt.setItem(key, '{"schemaVersion":1}');
    const recovered = createAutomaticScoreClient({ storage: corrupt, api: async () => { calls++; } });
    assert.equal(recovered.snapshot().phase, "blocked");
    await assert.rejects(recovered.submit("approve", packet()), /earlier/);
    assert.equal(calls, 0);
});

test("an uncertain approval survives panel reconstruction and only its status is read", async () => {
    const saved = storage(), calls = [];
    const api = async (route, input) => {
        calls.push(route);
        if (route.endsWith("/approve")) throw new Error("Synthetic response loss");
        return result(input);
    };
    const original = createAutomaticScoreClient({ storage: saved, api });
    await assert.rejects(original.submit("approve", packet()), /response loss/);
    assert.equal(original.snapshot().phase, "unknown");
    const recovered = createAutomaticScoreClient({ storage: saved, api });
    assert.equal(calls.length, 1, "Construction cannot submit or even read the earlier operation.");
    await assert.rejects(recovered.submit("approve", packet()), /earlier/);
    await recovered.check();
    assert.deepEqual(calls, ["/api/evaluation/automatic/approve", "/api/evaluation/automatic/status"]);
    assert.equal(saved.getItem(key), null);
});

test("pending and mismatched receipts cannot silently permit another approval", async () => {
    const saved = storage();
    let mode = "pending", calls = 0;
    const client = createAutomaticScoreClient({ storage: saved, api: async (_route, input) => {
        calls++;
        return mode === "mismatch" ? { ...result(input), mutationRef: "mutation-" + "f".repeat(32) } : result(input, mode);
    } });
    await client.submit("approve", packet());
    assert.equal(client.snapshot().phase, "pending");
    await assert.rejects(client.submit("approve", packet()), /earlier/);
    mode = "mismatch";
    await assert.rejects(client.check(), /does not match/);
    assert.equal(client.snapshot().phase, "unknown");
    mode = "purged";
    await client.check();
    assert.equal(client.snapshot().phase, "purged");
    assert.equal(saved.getItem(key), null);
    assert.equal(calls, 3);
    await assert.rejects(client.submit("revoke", packet()), /score approvals only/);
});

test("a known result with failed receipt cleanup stays known and blocks a new change", async () => {
    const saved = storage();
    const remove = saved.removeItem;
    saved.removeItem = () => { throw new Error("Synthetic cleanup failure"); };
    const client = createAutomaticScoreClient({ storage: saved, api: async (_route, input) => result(input) });
    await client.submit("approve", packet());
    assert.equal(client.snapshot().phase, "complete");
    assert.equal(client.snapshot().storageBlocked, true);
    await assert.rejects(client.submit("approve", packet()), /earlier/);
    saved.removeItem = remove;
    await client.check();
    assert.equal(client.snapshot().storageBlocked, false);
});

test("a confirmed Stop clears even corrupt positive receipts and supersedes a delayed approval reply", async () => {
    const saved = storage();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const client = createAutomaticScoreClient({ storage: saved, api: async (_route, input) => { await held; return result(input); } });
    const pending = client.submit("approve", packet());
    const rejected = assert.rejects(pending, error => error.code === "approval_superseded");
    const stop = { schemaVersion: 1, kind: "revoke", phase: "complete", data: { approvalRevision: 2 } };
    client.confirmStopped(stop);
    release(); await rejected;
    assert.equal(client.snapshot().phase, "idle");
    assert.equal(saved.getItem(key), null);
    saved.setItem(key, "INVALID");
    const corrupt = createAutomaticScoreClient({ storage: saved, api: async () => { assert.fail("Nothing should be sent"); } });
    assert.equal(corrupt.snapshot().storageBlocked, true);
    corrupt.confirmStopped(stop);
    assert.equal(corrupt.snapshot().storageBlocked, false);
    assert.equal(saved.getItem(key), null);
});
