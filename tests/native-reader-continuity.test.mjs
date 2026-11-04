import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { committedNativeReportFixture } from "./native-report-controller-fixture.mjs";
import { coworkFixture, recorded } from "./native-read-model-fixtures.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { createNativeRetainedViews } from "../lib/native-retained-views.mjs";
import { createBoundedNativeState } from "../web/bounded-native-state.mjs";

for (const segmented of [false, true]) test(`v${segmented ? 2 : 1} bounded reader frame preserves original bytes across collection`, async t => {
    const app = await committedNativeReportFixture(t, { segmented });
    const request = app.services.nativeReportAdmission;
    let held;
    const original = await app.persistence.withRetainedReader({ revision: null }, request, async reader => {
        held = reader;
        assert.throws(() => app.persistence.pinRetainedReader({ ...reader }, request), /FRAME/);
        return { frame: app.persistence.pinRetainedReader(reader, request), revision: reader.revision,
            source: reader.source, readback: reader.readback, entry: await reader.entryAt(1) };
    });

    assert.throws(() => app.persistence.pinRetainedReader(held, request), /FRAME/);
    const changed = coworkFixture();
    changed[1].qualifiedFields.message = recorded({ author: "user", representation: "follow-up", text: "Later collected wording." });
    const begun = await (segmented ? app.persistence.beginSegmented : app.persistence.begin)({ operationId: randomUUID() }, request);
    await (segmented ? app.persistence.commitSegmented : app.persistence.commit)(begun.ticket, changed);
    app.persistence.retire(begun.ticket);
    assert.ok((await loadBoardState(app.context)).revision > original.revision);
    await assert.rejects(app.persistence.withRetainedReader({ revision: original.revision }, request, () => true),
        /SOURCE_STALE/, "The generic current-root reader must not relax its revision check.");
    const pinned = await app.persistence.withPinnedRetainedReader(original.frame, request, async reader => ({
        revision: reader.revision, source: reader.source, readback: reader.readback, entry: await reader.entryAt(1),
    }));
    assert.deepEqual(pinned, { revision: original.revision, source: original.source, readback: original.readback, entry: original.entry });
    await assert.rejects(app.persistence.withPinnedRetainedReader({}, request, () => true), /FRAME/);
    await assert.rejects(app.persistence.withPinnedRetainedReader(original.frame, { ...request, owner: "another-reader-owner" }, () => true), /FRAME/);
    app.persistence.releaseRetainedReader(original.frame);
    await assert.rejects(app.persistence.withPinnedRetainedReader(original.frame, request, () => true), /FRAME/);
});

for (const change of ["configuration", "privacy", "deletion", "key", "logout"]) {
    test(`pinned reader retains current ${change} invalidation`, async t => {
        const app = await committedNativeReportFixture(t, { segmented: true }), request = app.services.nativeReportAdmission;
        const frame = await app.persistence.withRetainedReader({ revision: null }, request,
            reader => app.persistence.pinRetainedReader(reader, request));
        if (change === "logout") {
            await app.lifecycle.command(app.owner, { action: "wire-sign-out", operationId: randomUUID(),
                generation: (await app.lifecycle.status()).generation }, () => true);
        } else await updateBoardState(app.context, state => {
            if (change === "configuration") state.nativeRetention.configurationRevision++;
            if (change === "privacy") state.nativeRetention.privacyRevision++;
            if (change === "deletion") {
                state.deletion ??= { schemaVersion: 1, epoch: 0, identities: [], events: [], contextCalls: [], operations: {} };
                state.deletion.epoch++;
            }

            if (change === "key") state.pseudonymKey = "f".repeat(64);
        });
        let published = false;
        await assert.rejects(app.persistence.withPinnedRetainedReader(frame, request, () => { published = true; }));
        assert.equal(published, false);
        assert.ok((await loadBoardState(app.context)).nativeRetention.partitions.length,
            "Authority retirement must not delete retained data.");
    });
}

test("accepted detail pages and exact ordinals retain their original root while query and Search stay current", async t => {
    const app = await committedNativeReportFixture(t, { segmented: true }), request = app.services.nativeReportAdmission;
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    t.after(() => views.close());
    const query = { schemaVersion: 1, revision: null, sources: ["microsoft-365-cowork"],
        analytics: { layer: "tool", filters: { scope: "all" } }, page: { limit: 10, after: null } };
    const original = await views.query(query, request);
    assert.equal(original.readback.deletionVersion, 0);
    const input = { schemaVersion: 1, revision: original.revision, sourceRevision: original.sourceRevision,
        sources: query.sources, conversationId: original.page.items[0].id, section: "observations", page: { limit: 1, after: null } };
    const first = await views.detail(input, request);
    const model = createBoundedNativeState(), owner = {};
    model.receive(model.begin(input, owner), first, owner);
    const changed = coworkFixture();
    changed[1].qualifiedFields.message = recorded({ author: "user", representation: "follow-up", text: "Later collected wording." });
    const begun = await app.persistence.beginSegmented({ operationId: randomUUID() }, request);
    await app.persistence.commitSegmented(begun.ticket, changed);
    app.persistence.retire(begun.ticket);
    const next = model.next(), second = await views.detail(next, request);
    assert.equal(next.sourceRevision, original.sourceRevision);
    assert.equal(second.revision, original.revision);
    assert.deepEqual(second.readback, original.readback);
    assert.equal(second.page.items[0].fields.message.value.text, "Read the invented records.");
    model.receive(model.begin(next, owner), second, owner);
    const exact = await views.detail({ ...input, at: 1 }, request);
    assert.equal(exact.page.items[0].id, second.page.items[0].id);
    assert.equal(exact.focusOrdinal, 1);
    await assert.rejects(views.detail({ ...input, sourceRevision: "f".repeat(64) }, request), /STALE/);
    await assert.rejects(views.detail(input, { ...request, owner: "another-reader-owner" }), /STALE/);
    await assert.rejects(views.query({ ...query, revision: original.revision }, request), /STALE/);
    await assert.rejects(views.search({ schemaVersion: 1, revision: original.revision, sources: query.sources,
        query: "Read", types: [], page: { limit: 10, after: null } }, request), /STALE/);
    const current = await views.query(query, request);
    assert.notEqual(current.sourceRevision, original.sourceRevision);
    await updateBoardState(app.context, state => { state.nativeRetention.privacyRevision++; });
    await assert.rejects(views.detail(input, request), /STALE/);
});
