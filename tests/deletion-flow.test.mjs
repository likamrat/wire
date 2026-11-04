import test from "node:test";
import assert from "node:assert/strict";
import { createDeletionFlow } from "../web/deletion-flow.mjs";

test("scope changes revoke a preview; uncertain confirmation can only read its original receipt", () => {
    const flow = createDeletionFlow();
    const token = flow.edit({ scope: "all" });
    assert.equal(flow.accept(token, { operationId: "first", counts: { records: 2 } }), true);
    flow.edit({ scope: "range", from: "2026-10-01", to: "2026-10-01" });
    assert.equal(flow.accept(token, { operationId: "stale" }), false);
    assert.equal(flow.begin(), null);
    flow.accept(flow.token(), { operationId: "sealed", counts: { records: 1 } });
    assert.equal(flow.begin(), "sealed");
    assert.equal(flow.begin(), null, "No duplicate commit");
    flow.uncertain("Connection lost");
    assert.equal(flow.begin(), null, "Never retry a mutation after uncertainty");
    assert.equal(flow.snapshot().operationId, "sealed");
    assert.equal(flow.edit({ scope: "all" }), null, "Resolve original operation before permitting a new one");
    flow.result({ phase: "complete", operationId: "sealed" });
    assert.equal(flow.snapshot().phase, "complete");
});

test("withdrawal forgets private deletion state while retaining only the dispatched operation and uncertainty", () => {
    const flow = createDeletionFlow();
    const token = flow.edit({ scope: "range", from: "2026-10-01", to: "2026-10-02" });
    flow.accept(token, { operationId: "original", counts: { records: 3 }, privateScope: "PRIVATE_SCOPE" });
    flow.begin();
    flow.withdrawAccess();
    assert.deepEqual(flow.snapshot(), { phase: "uncertain", operationId: "original" });
    assert.equal(flow.accept(token, { operationId: "late", counts: { records: 8 } }), false);
    assert.equal(flow.begin(), null);
    flow.withdrawAccess();
    assert.deepEqual(flow.snapshot(), { phase: "uncertain", operationId: "original" });
    flow.result({ operationId: "original", phase: "complete", counts: { records: 3 } });
    flow.withdrawAccess();
    assert.deepEqual(flow.snapshot(), { phase: "complete", operationId: "original" });
});
