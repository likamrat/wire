import test from "node:test";
import assert from "node:assert/strict";
import { privateFixture } from "./helpers.mjs";
import { loadBoardState, replaceEvidence, updateBoardState } from "../lib/store.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { recordUnits, filterDeletedRecords, deletionHash } from "../lib/deletion-identities.mjs";
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";

const original = () => ({
    scenarioId: "synthetic-local-identity",
    toolCalls: [
        { tool: "unknown", startedAt: "2026-10-01T00:00:00.000Z" },
        { tool: "unknown", startedAt: "2026-10-02T00:00:00.000Z" },
    ],
});
const range = { scope: "range", from: "2026-10-01", to: "2026-10-01", timeContext: { timeZone: "UTC", locale: "en-US" } };

test("local fallback filtering is idempotent and preserves the second anonymous dated call", () => {
    const record = original(), deletion = { identities: recordUnits(record)[0].aliases };
    const once = filterDeletedRecords([record], deletion);
    const twice = filterDeletedRecords(once, deletion);
    assert.equal(once.length, 1);
    assert.deepEqual(once[0].toolCalls, [record.toolCalls[1]]);
    assert.deepEqual(twice, once);
});

test("actual range deletion of an anonymous call preserves the out-of-range call through repeated reads and recovery", async t => {
    const record = original();
    const { context } = await privateFixture(t, [record]);
    const controller = createDeletionController(context);
    const preview = await controller.preview("panel", range);
    assert.equal(preview.counts.records, 1);
    assert.equal(preview.counts.partialGroups, 1);
    const result = await controller.confirm("panel", { operationId: preview.operationId, confirmed: true });
    assert.equal(result.phase, "complete");
    const state = await loadBoardState(context);
    assert.equal(state.evidence.length, 1);
    assert.deepEqual(state.evidence[0].toolCalls, [record.toolCalls[1]]);
    const restarted = createDeletionController(context);
    await restarted.recover();
    const afterRestart = await loadBoardState(context);
    assert.deepEqual(afterRestart.evidence, state.evidence);
    assert.equal((await restarted.preview("panel", range)).counts.records, 0);
    const late = structuredClone(record);
    late.toolCalls[0] = { ...late.toolCalls[0], completionEventId: "late", completedAt: "2026-10-03T00:00:00.000Z",
        reportedOutcome: "succeeded", toolSucceeded: true, apiResults: [{ statusCode: 200 }], durationMs: 172800000 };
    await replaceEvidence(context, () => ({ records: [late] }));
    const recollected = await loadBoardState(context);
    assert.deepEqual(recollected.evidence[0].toolCalls, [record.toolCalls[1]], "Late result replay cannot restore the deleted anonymous start");
    assert.deepEqual(filterDeletedRecords(recollected.evidence, recollected.deletion), recollected.evidence);
});

test("local identities use the existing date-grain fallback, not a shared anonymous array index", () => {
    const call = { tool: "unknown", requestArgs: { text: "SYNTHETIC_秘密" } };
    const first = { scenarioId: "same-local-owner", capturedAt: "2026-10-01T00:00:00.000Z", toolCalls: [call] };
    const second = { ...first, capturedAt: "2026-10-02T00:00:00.000Z" };
    assert.notDeepEqual(recordUnits(first)[0].aliases, recordUnits(second)[0].aliases);
    const deletion = { identities: recordUnits(first)[0].aliases };
    assert.deepEqual(filterDeletedRecords([second], deletion)[0].toolCalls, [call]);
    assert.doesNotMatch(JSON.stringify(deletion), /SYNTHETIC|unknown|2026/);
});

test("fallback fingerprints are stable through relation pruning, completion metadata, key ordering and array reordering", () => {
    const record = { ...original(), sourceSessionId: "synthetic-source" };
    record.toolCalls[0] = { ...record.toolCalls[0], toolCallId: "canonical-parent", startEventId: "canonical-start" };
    record.toolCalls[1] = { ...record.toolCalls[1], parentToolCallId: "canonical-parent", requestArgs: { b: 2, a: { x: "秘密", y: 1 } } };
    const originalAlias = recordUnits(record)[1].aliases;
    const first = filterDeletedRecords([record], { identities: recordUnits(record)[0].aliases });
    assert.equal(first[0].toolCalls[0].parentToolCallId, null);
    assert.deepEqual(recordUnits(first[0])[0].aliases, originalAlias);
    const reordered = { ...record, toolCalls: [{
        requestArgs: { a: { y: 1, x: "秘密" }, b: 2 }, startedAt: record.toolCalls[1].startedAt, tool: "unknown",
        order: 99, reportedOutcome: "succeeded", completionEventId: "late", parentToolCallId: null,
    }, record.toolCalls[0]] };
    assert.deepEqual(recordUnits(reordered)[0].aliases, originalAlias);
    assert.deepEqual(recordUnits(reordered)[1].aliases, recordUnits(record)[0].aliases);
});

test("ambiguous anonymous repeats fail closed rather than merging distinguishable occurrences", () => {
    const call = { tool: "unknown", startedAt: "2026-10-01T00:00:00.000Z", requestArgs: { query: "SYNTHETIC_PRIVATE_秘密" } };
    const kept = { ...call, startedAt: "2026-10-02T00:00:00.000Z" };
    const record = { scenarioId: "anonymous-repeats", toolCalls: [call, structuredClone(call), kept] };
    const deletion = { identities: recordUnits(record)[0].aliases };
    assert.throws(() => filterDeletedRecords([record], deletion), error => error.code === "AMBIGUOUS_LOCAL_DELETION_IDENTITY");
    record.toolCalls[1].reportedOutcome = "failed";
    assert.throws(() => filterDeletedRecords([record], deletion), error => error.code === "AMBIGUOUS_LOCAL_DELETION_IDENTITY");
    assert.equal(record.toolCalls.length, 3);
    assert.doesNotMatch(JSON.stringify(deletion), /SYNTHETIC|PRIVATE|秘密|query/);
});

test("old positional markers fail closed rather than ambiguously deleting a shifted local survivor", () => {
    const record = original(), survivor = { ...record, toolCalls: [record.toolCalls[1]] };
    const legacy = { identities: [deletionHash(JSON.stringify(["local", record.scenarioId, "toolCalls", 0]))] };
    assert.throws(() => filterDeletedRecords([survivor], legacy), /positional.*cannot safely/);
    assert.deepEqual(survivor.toolCalls, [record.toolCalls[1]]);
});

test("persisted ambiguous legacy markers reject preview explicitly without writing another deletion", async t => {
    const record = original(), survivor = { ...record, toolCalls: [record.toolCalls[1]] };
    const { context } = await privateFixture(t, [survivor]);
    await updateBoardState(context, state => {
        state.deletion = { schemaVersion: 1, identities: [deletionHash(JSON.stringify(["local", record.scenarioId, "toolCalls", 0]))],
            events: [], contextCalls: [], operations: {} };
    });
    const before = await loadBoardState(context);
    await assert.rejects(createDeletionController(context).preview("panel", { scope: "all", timeContext: range.timeContext }),
        error => error.status === 409 && /positional.*cannot safely/.test(error.message));
    assert.deepEqual((await loadBoardState(context)).evidence, before.evidence);
    assert.equal((await loadBoardState(context)).revision, before.revision);
});

test("anonymous selection rejects indistinguishable occurrences without modifying unrelated identifiable records or files", async t => {
    const record = original();
    record.toolCalls.push({ ...record.toolCalls[0], reportedOutcome: "failed" });
    const identifiable = { scenarioId: "unrelated", sourceSessionId: "source", toolCalls: [
        { tool: "workiq-fetch", toolCallId: "safe-call", startEventId: "safe-start", startedAt: "2026-10-02T00:00:00.000Z" },
    ] };
    const { context } = await privateFixture(t, [record, identifiable]);
    const before = await loadBoardState(context);
    const snapshot = path.join(context.dataDir, "private-evidence", before.evidenceFile);
    const bytes = await readFile(snapshot);
    await assert.rejects(createDeletionController(context).preview("panel", range),
        error => error.status === 409 && /indistinguishable/.test(error.message));
    assert.deepEqual(await readFile(snapshot), bytes);
    assert.deepEqual((await loadBoardState(context)).evidence, [record, identifiable]);
    assert.equal((await loadBoardState(context)).revision, before.revision);
});

test("local identities are stable for every family across deletion subsets, permutations and appended distinct records", () => {
    for (const family of ["toolCalls", "graphActivities", "httpRecords"]) {
        const items = Array.from({ length: 6 }, (_, index) => ({
            tool: "unknown", startedAt: `2026-10-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
            requestArgs: { scope: `SYNTHETIC_${index}` },
        }));
        const record = { scenarioId: `local-${family}`, [family]: items };
        const aliases = recordUnits(record).map(unit => unit.aliases[0]);
        for (let mask = 0; mask < 64; mask++) {
            const blocked = aliases.filter((_, index) => mask & (1 << index));
            const deletion = { identities: blocked };
            const once = filterDeletedRecords([record], deletion);
            assert.deepEqual(filterDeletedRecords(once, deletion), once, `${family}/${mask}: F(F(x)) = F(x)`);
            const expected = items.filter((_, index) => !(mask & (1 << index)));
            assert.deepEqual(once.flatMap(row => row[family]), expected);
            const reversed = { ...record, [family]: [...items].reverse() };
            assert.deepEqual(filterDeletedRecords([reversed], deletion).flatMap(row => row[family]), [...expected].reverse());
            const fresh = { tool: "unknown", startedAt: "2026-10-09T00:00:00.000Z", requestArgs: { scope: "SYNTHETIC_NEW" } };
            assert.deepEqual(filterDeletedRecords([{ ...record, [family]: [...items, fresh] }], deletion).flatMap(row => row[family]), [...expected, fresh]);
        }
    }
});

test("existing call/start, Graph and HTTP aliases are byte-for-byte unchanged", () => {
    const record = { scenarioId: "canonical", sourceSessionId: "source",
        toolCalls: [{ toolCallId: "call", startEventId: "start" }],
        graphActivities: [{ activityId: "activity" }], httpRecords: [{ recordId: "http" }] };
    assert.deepEqual(recordUnits(record).map(unit => unit.aliases), [
        [deletionHash(JSON.stringify(["call", "source", "call"])), deletionHash(JSON.stringify(["start", "source", "start"]))],
        [deletionHash(JSON.stringify(["graph", "source", "activity"]))],
        [deletionHash(JSON.stringify(["http", "http"]))],
    ]);
});

test("different request shapes or local identifiers never merge just because timestamps and tool names match", () => {
    const base = { tool: "unknown", startedAt: "2026-10-01T00:00:00.000Z" };
    const calls = [
        { ...base, requestArgs: { method: "GET", path: "/synthetic/a" } },
        { ...base, requestArgs: { method: "POST", path: "/synthetic/a" } },
        { ...base, requestArgs: { method: "GET", path: "/synthetic/b" } },
        { ...base, toolCallId: "unmapped-call-a" },
        { ...base, toolCallId: "unmapped-call-b" },
    ];
    const record = { scenarioId: "same-time-distinct", toolCalls: calls };
    const units = recordUnits(record);
    assert.equal(new Set(units.map(unit => unit.aliases[0])).size, calls.length);
    for (const [index, unit] of units.entries()) {
        const kept = filterDeletedRecords([record], { identities: unit.aliases });
        assert.deepEqual(kept[0].toolCalls, calls.filter((_, offset) => offset !== index));
        assert.deepEqual(filterDeletedRecords(kept, { identities: unit.aliases }), kept);
    }
});

test("interrupted real range cleanup recovers the sealed local identity without altering the survivor, external source or saved copy", async t => {
    const record = original(), { context, root } = await privateFixture(t, [record]);
    const source = path.join(root, "synthetic-source.jsonl"), report = path.join(context.dataDir, "exports", "synthetic-saved-report.json");
    const sourceBytes = JSON.stringify(record) + "\n", reportBytes = JSON.stringify({ frozen: record });
    await writeFile(source, sourceBytes);
    await writeFile(report, reportBytes);
    const before = await loadBoardState(context);
    await writeFile(path.join(context.dataDir, "prior-state.snapshot.json"), JSON.stringify(before));
    const controller = createDeletionController(context, { afterSeal: () => { throw new Error("SYNTHETIC_INTERRUPT"); } });
    const preview = await controller.preview("panel", range);
    assert.equal(preview.counts.anonymousRecords, 1);
    assert.equal(preview.counts.anonymousToolCalls, 1);
    await assert.rejects(controller.confirm("panel", { operationId: preview.operationId, confirmed: true }), /SYNTHETIC_INTERRUPT/);
    await assert.rejects(loadBoardState(context), /incomplete/);
    const restarted = createDeletionController(context);
    await restarted.recover();
    const after = await loadBoardState(context);
    assert.deepEqual(after.evidence[0].toolCalls, [record.toolCalls[1]]);
    assert.deepEqual(filterDeletedRecords(after.evidence, after.deletion), after.evidence);
    const backup = JSON.parse(await readFile(path.join(context.dataDir, "prior-state.snapshot.json")));
    const backupEvidence = JSON.parse(await readFile(path.join(context.dataDir, "private-evidence", backup.evidenceFile)));
    assert.deepEqual(backupEvidence.records[0].toolCalls, [record.toolCalls[1]]);
    assert.equal(await readFile(source, "utf8"), sourceBytes);
    assert.equal(await readFile(report, "utf8"), reportBytes);
});

test("All deletes uniquely identifiable local snapshots without suppressing a later distinct anonymous start", async t => {
    const record = original(), { context } = await privateFixture(t, [record]);
    const controller = createDeletionController(context);
    const preview = await controller.preview("panel", { scope: "all", timeContext: range.timeContext });
    assert.equal(preview.counts.records, 2);
    assert.equal(preview.counts.anonymousRecords, 2);
    await controller.confirm("panel", { operationId: preview.operationId, confirmed: true });
    assert.deepEqual((await loadBoardState(context)).evidence, []);
    const fresh = { tool: "unknown", startedAt: "2026-10-03T00:00:00.000Z" };
    await replaceEvidence(context, () => ({ records: [{ ...record, toolCalls: [...record.toolCalls, fresh] }] }));
    assert.deepEqual((await loadBoardState(context)).evidence[0].toolCalls, [fresh]);
    const restarted = createDeletionController(context);
    await restarted.recover();
    assert.deepEqual((await loadBoardState(context)).evidence[0].toolCalls, [fresh]);
    assert.equal((await restarted.confirm("panel", { operationId: preview.operationId, confirmed: true })).phase, "complete");
    assert.deepEqual((await loadBoardState(context)).evidence[0].toolCalls, [fresh]);
});

test("restart refuses a legacy sealed plan whose hash-valid replacement already over-pruned anonymous survivors", async t => {
    const record = original(), { context } = await privateFixture(t, [record]);
    const controller = createDeletionController(context, { afterSeal: () => { throw new Error("SYNTHETIC_PRE_UPGRADE_CRASH"); } });
    const preview = await controller.preview("panel", range);
    await assert.rejects(controller.confirm("panel", { operationId: preview.operationId, confirmed: true }), /SYNTHETIC_PRE_UPGRADE_CRASH/);
    const stateFile = path.join(context.dataDir, "workiq-evidence-board-v1.state.json");
    const legacy = JSON.parse(await readFile(stateFile));
    const operation = legacy.deletion.operations[preview.operationId];
    delete operation.localIdentityVersion;
    delete operation.counts.anonymousRecords;
    legacy.deletion.identities = [deletionHash(JSON.stringify(["local", record.scenarioId, "toolCalls", 0]))];
    const badReplacement = JSON.stringify({ records: [] }), badName = `${deletionHash(badReplacement)}.json`;
    await writeFile(path.join(context.dataDir, "private-evidence", badName), badReplacement);
    legacy.evidenceFile = badName;
    legacy.cards = {};
    await writeFile(stateFile, JSON.stringify(legacy));
    async function inventory() {
        const files = await readdir(context.dataDir, { recursive: true, withFileTypes: true });
        return Object.fromEntries(await Promise.all(files.filter(file => file.isFile()).map(async file => {
            const name = path.join(file.parentPath, file.name);
            return [path.relative(context.dataDir, name), deletionHash(await readFile(name))];
        })));
    }
    const before = await inventory();
    const restarted = createDeletionController(context);
    await assert.rejects(restarted.recover(), error => error.status === 409 && /legacy.*pending|pending.*legacy/i.test(error.message));
    assert.deepEqual(await inventory(), before, "Do not execute any physical recipe or rewrite the pending receipt");
    assert.equal((await restarted.status(preview.operationId)).phase, "pending");
    await assert.rejects(loadBoardState(context), /incomplete/);
});
