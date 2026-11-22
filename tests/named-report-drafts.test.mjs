import test from "node:test";
import assert from "node:assert/strict";
import { privateFixture, fixture } from "./helpers.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { editNamedDrafts, namedDraftCatalog, assertNamedSelection } from "../lib/named-report-drafts.mjs";

test("one interaction can belong to two drafts; removal is local to one draft after reload", async t => {
    const { context } = await privateFixture(t, [fixture("x"), fixture("y")]);
    const read = async () => namedDraftCatalog(await loadBoardState(context), "test-source");
    const edit = async (input) => editNamedDrafts(context, "test-source", { ...input, expected: (await read()).version }, () => {});
    await edit({ name: "Launch review", scenarioId: "x", included: true });
    const a = (await read()).drafts[0].id;
    await edit({ id: a, scenarioId: "y", included: true });
    await edit({ name: "Handoff", scenarioId: "y", included: true });
    await edit({ id: a, scenarioId: "y", included: false });
    assert.deepEqual((await read()).drafts.map(d => [d.name, d.scenarioIds]), [["Launch review", ["x"]], ["Handoff", ["y"]]]);
    const state = await loadBoardState(context);
    assert.equal(state.evidence.length, 2);
    assert.deepEqual(state.exports, []);
    assert.deepEqual(namedDraftCatalog(state, "different-source").drafts, []);
});

test("another panel cannot overwrite a newer edit or prepare stale, substituted or cross-source members", async t => {
    const { context } = await privateFixture(t, [fixture("x"), fixture("y")]);
    const read = async () => namedDraftCatalog(await loadBoardState(context), "source");
    const base = await read();
    const added = await editNamedDrafts(context, "source", { expected: base.version, name: "Review", included: true, scenarioId: "x" });
    const command = { expected: added.catalog.version, id: added.draftId, included: true, scenarioId: "y" };
    await editNamedDrafts(context, "source", command);
    await assert.rejects(editNamedDrafts(context, "source", { ...command, scenarioId: "x", included: false }), { status: 409 });
    await assert.rejects(editNamedDrafts(context, "another", { ...command, expected: (await read()).version }), { status: 409 });
    const state = await loadBoardState(context), binding = { id: added.draftId, revision: 2 }, two = { kind: "selected", scenarioIds: ["y", "x"] };
    assert.doesNotThrow(() => assertNamedSelection(state, "source", binding, two));
    for (const invalid of [
        ["another", binding, two], ["source", { ...binding, revision: 1 }, two], ["source", binding, { ...two, scenarioIds: ["y"] }],
    ]) assert.throws(() => assertNamedSelection(state, ...invalid), { status: 409 });
});

test("deleting collected activity retires its draft memberships but preserves the named draft", async t => {
    const { context } = await privateFixture(t, [fixture("x")]);
    const read = async () => namedDraftCatalog(await loadBoardState(context), "source");
    await editNamedDrafts(context, "source", { expected: (await read()).version, name: "Launch", included: true, scenarioId: "x" });
    const controller = createDeletionController(context);
    const preview = await controller.preview("panel", { scope: "all", timeContext: { timeZone: "UTC", locale: "en-US" } });
    await controller.confirm("panel", { operationId: preview.operationId, confirmed: true });
    const [draft] = (await read()).drafts;
    assert.equal(draft.name, "Launch"); assert.deepEqual(draft.scenarioIds, []); assert.equal(draft.unavailable, 0);
});
