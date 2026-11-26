import test from "node:test";
import assert from "node:assert/strict";
import { privateFixture, fixture } from "../support/helpers.mjs";
import { loadBoardState } from "../../lib/store.mjs";
import { createDeletionController } from "../../lib/deletion.mjs";
import { editNamedDrafts, namedDraftCatalog, assertNamedSelection } from "../../lib/named-report-drafts.mjs";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { createCopilotRuntimeAccess } from "../../lib/runtime-access.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createProfileSource, profileProjectId } from "../collection/source-profile-fixture.mjs";

async function runWriter(context, run) {
    const access = await createCopilotRuntimeAccess(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, access, collector: { timers: false } });
    try {
        const base = new URL(runtime.url).origin, headers = { Origin: base, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1" };
        const post = async (route, body = {}, status = 200) => {
            const response = await fetch(base + route, { method: "POST", headers, body: JSON.stringify(body) });
            const value = await response.json();
            assert.equal(response.status, status, value.error);
            return value;
        };
        headers["X-Board-Capability"] = (await post("/api/session")).capability;
        return await run(post);
    } finally { await runtime.close(); await access.close(); }
}

test("a fresh authorized runtime on the same store can reopen the same named draft", async t => {
    const { context } = await privateFixture(t, [fixture("x")]);
    const first = await runWriter(context, async post => {
        const catalog = await post("/api/report-drafts/list");
        return (await post("/api/report-drafts/edit", { expected: catalog.version, scenarioId: "x", name: "Notebook", included: true })).catalog;
    });
    const reopened = await runWriter(context, post => post("/api/report-drafts/list"));
    assert.deepEqual(reopened.drafts, first.drafts);
});

test("drafts survive restart for their approved source and account, not another account or copied source", async t => {
    const cleanups = [];
    const { context, root } = await privateFixture({ after: work => cleanups.push(work) }, [fixture("x"), fixture("y")]);
    const a = await createProfileSource(root), otherRoot = path.join(root, "other");
    await mkdir(otherRoot); const b = await createProfileSource(otherRoot);
    t.after(async () => { a.db.close(); b.db.close(); for (const cleanup of cleanups.reverse()) await cleanup(); });
    const configDir = path.join(context.dataDir, "collector"); await mkdir(configDir, { recursive: true });
    const use = source => writeFile(path.join(configDir, "config.json"), JSON.stringify({ schemaVersion: 1, approved: true,
        approvedAt: "2026-10-01T12:00:00.000Z", appDbPath: source.appDbPath, sessionRoot: source.sessionRoot,
        enabled: false, windowDays: 30, pollSeconds: 60 }));
    const list = post => post("/api/report-drafts/list");
    const selectAccount = id => a.db.prepare("UPDATE projects SET github_account_id=? WHERE id=?").run(id, profileProjectId);
    await use(a);
    const first = await runWriter(context, async post => {
        let catalog = await list(post);
        for (const [scenarioId, name] of [["x", "Notebook"], ["y", "Calendar"]]) {
            ({ catalog } = await post("/api/report-drafts/edit", { expected: catalog.version, scenarioId, name, included: true }));
        }
        return catalog;
    });
    assert.deepEqual(first.drafts.map(d => [d.name, d.scenarioIds]), [["Notebook", ["x"]], ["Calendar", ["y"]]]);
    const deletion = { action: "delete", expected: first.version, id: first.drafts[0].id };
    const otherAccount = await runWriter(context, async post => {
        assert.deepEqual((await list(post)).drafts, first.drafts);
        selectAccount("default");
        assert.deepEqual((await list(post)).drafts, []);
        await post("/api/report-drafts/edit", { expected: first.version, scenarioId: "x", id: first.drafts[0].id, included: false }, 409);
        await post("/api/report-drafts/edit", deletion, 409);
        await post("/api/report-drafts/edit", { ...deletion, expected: (await list(post)).version }, 409);
        const { catalog } = await post("/api/report-drafts/edit", { expected: (await list(post)).version, scenarioId: "y", name: "Notebook", included: true });
        selectAccount("workspace");
        assert.deepEqual((await list(post)).drafts, first.drafts);
        return catalog.drafts;
    });
    await use(b);
    await runWriter(context, async post => {
        assert.deepEqual((await list(post)).drafts, []);
        await post("/api/report-drafts/edit", deletion, 409);
    });
    await use(a);
    assert.deepEqual((await runWriter(context, list)).drafts, first.drafts);
    await runWriter(context, async post => {
        const changed = await post("/api/report-drafts/edit", { expected: first.version, scenarioId: "y", id: deletion.id, included: true });
        await post("/api/report-drafts/edit", deletion, 409);
        const confirmed = await post("/api/report-drafts/edit", { ...deletion, expected: changed.catalog.version });
        assert.deepEqual(confirmed.catalog.drafts, first.drafts.slice(1));
    });
    assert.deepEqual((await runWriter(context, list)).drafts, first.drafts.slice(1));
    selectAccount("default");
    assert.deepEqual((await runWriter(context, list)).drafts, otherAccount);
});

test("one interaction can belong to two drafts; removal is local to one draft after reload", async t => {
    const { context } = await privateFixture(t, [fixture("x"), fixture("y")]);
    const read = async () => namedDraftCatalog(await loadBoardState(context), "test-source");
    const edit = async (input) => editNamedDrafts(context, "test-source", { ...input, expected: (await read()).version }, () => {});
    await edit({ name: "Launch review", scenarioId: "x", included: true });
    const { id: a, createdAt } = (await read()).drafts[0];
    assert.equal(new Date(createdAt).toISOString(), createdAt);
    await edit({ id: a, scenarioId: "y", included: true });
    await edit({ name: "Handoff", scenarioId: "y", included: true });
    await edit({ id: a, scenarioId: "y", included: false });
    assert.deepEqual((await read()).drafts.map(d => [d.name, d.scenarioIds]), [["Launch review", ["x"]], ["Handoff", ["y"]]]);
    const state = await loadBoardState(context);
    assert.equal((await read()).drafts[0].createdAt, createdAt);
    // Pre-date records remain readable without manufacturing a creation instant.
    delete Object.values(state.namedReportDrafts.partitions)[0].drafts[0].createdAt;
    assert.equal(Object.hasOwn(namedDraftCatalog(state, "test-source").drafts[0], "createdAt"), false);
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
