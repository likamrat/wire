import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { privateFixture } from "./helpers.mjs";
import { chatFixture, coworkFixture } from "./native-read-model-fixtures.mjs";
import { BOARD_ID } from "../lib/evidence.mjs";
import { loadBoardState, updateBoardState, stagePrivateEvidence } from "../lib/store.mjs";
import { acquireCollectorLock } from "../lib/collector-io.mjs";
import { createMicrosoftNativeReadTransport } from "../lib/microsoft-native-transport.mjs";
import { createMicrosoftSession } from "../lib/microsoft-session.mjs";
import { createNativePersistence } from "../lib/native-persistence.mjs";
import { validateNativeRetainedDocument } from "../lib/native-retention-contract.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { nativeObservationDeletionIdentity } from "../lib/deletion-identities.mjs";
import { nativeFailureDetails, withNativeFailurePredicate, withNativeFailureAdmission, validNativeFailure } from "../lib/microsoft-session-state.mjs";
import { readArchivedNativeReceipt } from "../lib/native-receipt-archive.mjs";
import { attachNativeBackfill, createNativeBackfill, nativeBackfillSummary, validateNativeBackfillSummary } from "../lib/native-backfill-state.mjs";
import { nativeRetentionHash } from "../lib/native-retention-contract.mjs";
import { createCollectionStatus } from "../lib/collection-status.mjs";
import { nativeProtocolFailure } from "../lib/microsoft-native-host.mjs";

async function setup(t, { backfillTracking = false, sourceSurface = "cowork" } = {}) {
    const cleanups = [], { context } = await privateFixture({ after: work => cleanups.push(work) }, []);
    let release = await acquireCollectorLock(context.dataDir);
    const source = sourceSurface === "chat" ? chatFixture() : coworkFixture();
    let persistence, requesterLive = true, requesterChecks = 0, providerCalls = 0;
    const account = source[0].scope.account;
    let verifiedAccount = account;
    const transport = createMicrosoftNativeReadTransport({
        async open() { providerCalls++; },
        async verifyAccount() {
            providerCalls++;
            return { tenantId: verifiedAccount.tenantId, subjectId: verifiedAccount.subjectId, knownAccountMatched: true, chat: true, cowork: true,
                evidence: { kind: "native-account-metadata", issuer: "https://example.invalid", observedAt: new Date().toISOString() } };
        },
        async stop() { return { processExited: true, profileReleased: true }; },
    });
    const lifecycle = await createMicrosoftSession(context, { transport, collection: { paused: false, windowDays: 30 },
        persistCollectionSettings: (settings, token) => persistence.persistCollectionSettings(settings, token) });
    t.after(async () => {
        persistence?.close(); await lifecycle.close(); await release?.();
        for (const cleanup of cleanups) await cleanup();
    });
    persistence = await createNativePersistence(context, { lifecycle, transport, backfillTracking });
    const owner = "native-comparison-test-owner";
    const admission = { owner, check() { requesterChecks++; return requesterLive; }, dispatched() {} };
    for (const action of ["wire-sign-in", "microsoft-connect"]) {
        const result = await lifecycle.command(owner, { action, operationId: randomUUID(),
            generation: (await lifecycle.status()).generation, ...(action === "microsoft-connect" ? { replace: false } : {}) }, () => true);
        assert.equal(result.outcome, "completed");
    }
    await persistence.configure({ expectedRevision: null, surfaces: ["chat", "cowork"], windowDays: 30 }, admission);
    const begin = async () => (await persistence.begin({ operationId: randomUUID() }, admission)).ticket;
    const bytes = () => readFile(path.join(context.dataDir, `${BOARD_ID}.state.json`));
    const retained = async () => persistence.readAuthorized(await lifecycle.lease("microsoft-retained"));
    return { context, get persistence() { return persistence; }, lifecycle, source, owner, admission, begin, bytes, retained,
        get requesterChecks() { return requesterChecks; }, get providerCalls() { return providerCalls; },
        releaseRequester() { requesterLive = false; },
        async restartPersistence() {
            persistence.close();
            persistence = await createNativePersistence(context, { lifecycle, transport, backfillTracking });
        },
        async withoutWriter(work) {
            await release(); release = null;
            try { return await work(); }
            finally { release = await acquireCollectorLock(context.dataDir); }
        },
        async replaceAccount() {
            verifiedAccount = { tenantId: "alternate-tenant", subjectId: "alternate-subject" };
            return lifecycle.command(owner, { action: "microsoft-connect", operationId: randomUUID(),
                generation: (await lifecycle.status()).generation, replace: true }, () => true);
        } };
}

test("existing receipt archive recovers a controlled hot journal only under collector custody", { timeout: 30000 }, async t => {
    const app = await setup(t);
    const first = await app.persistence.beginSegmented({ operationId: randomUUID() }, app.admission);
    await app.persistence.commitSegmented(first.ticket, app.source);
    app.persistence.retire(first.ticket);
    const ids = Array.from({ length: 127 }, () => randomUUID());
    await updateBoardState(app.context, state => {
        const receipt = state.nativeRetention.receipts[0];
        state.nativeRetention.receipts.push(...ids.map(operationId => ({ ...structuredClone(receipt), operationId })));
    });
    const pending = await app.persistence.beginSegmented({ operationId: randomUUID() }, app.admission);
    app.persistence.retire(pending.ticket);
    const state = await loadBoardState(app.context), archiveId = state.nativeRetention.receiptArchive.id;
    const file = path.join(app.context.dataDir, "collector", "native-receipts", `${archiveId}.sqlite`);
    const receipt = (await app.persistence.status({ operationId: ids[0] }, { owner: app.owner })).receipt;
    const before = await app.bytes(), providerCalls = app.providerCalls;
    const { NODE_TEST_CONTEXT: _testContext, ...environment } = process.env;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
        import { DatabaseSync } from 'node:sqlite';
        import { readFileSync } from 'node:fs';
        const file = process.argv[1], database = new DatabaseSync(file);
        database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=1; PRAGMA cache_spill=ON; BEGIN IMMEDIATE;');
        database.prepare('UPDATE archive_info SET archive_id=?').run('uncommitted-identity');
        database.prepare('UPDATE receipts SET receipt_json=receipt_json || ?').run('x'.repeat(16384));
        const journal = readFileSync(file + '-journal');
        process.on('message', () => { if (!database.isOpen) process.exit(2); });
        process.send({ ready: true, header: journal.subarray(0,8).toString('hex'), bytes: journal.length });
    `, file], { env: environment, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    let timer, stderr = "";
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4096); });
    try {
        const ready = await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Owned journal fixture did not become ready.")), 10000);
            child.once("message", resolve); child.once("error", reject);
            child.once("exit", () => reject(new Error("Owned journal fixture exited before readiness: " + stderr)));
        });
        assert.equal(ready.ready, true);
        assert.equal(ready.header, "d9d505f920a163d7");
        assert.ok(ready.bytes > 512);
        child.kill("SIGKILL");
        await exited;
    } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
    }
    const journal = await readFile(file + "-journal");
    assert.equal(journal.subarray(0, 8).toString("hex"), "d9d505f920a163d7");
    await app.restartPersistence();
    await app.withoutWriter(async () => {
        await assert.rejects(app.persistence.status({ operationId: ids[0] }, { owner: app.owner }),
            { code: "COLLECTOR_LOCK_REQUIRED" });
        assert.deepEqual(await readFile(file + "-journal"), journal);
    });
    await filesystem.rename(file, file + ".saved");
    try {
        await assert.rejects(app.persistence.beginSegmented({ operationId: randomUUID() }, app.admission),
            { code: "NATIVE_RETENTION_RECEIPT_ARCHIVE_UNAVAILABLE" });
        await assert.rejects(filesystem.stat(file), { code: "ENOENT" });
        assert.deepEqual(await readFile(file + "-journal"), journal, "Missing database recovery must not delete its journal.");
    } finally { await filesystem.rename(file + ".saved", file); }
    assert.deepEqual((await app.persistence.status({ operationId: ids[0] }, { owner: app.owner })).receipt, receipt);
    assert.equal((await app.persistence.beginSegmented({ operationId: ids[0] }, app.admission)).kind, "committed");
    assert.deepEqual(await app.bytes(), before, "Journal recovery cannot register another collection or change source state.");
    assert.equal(app.providerCalls, providerCalls);
    await assert.rejects(filesystem.stat(file + "-journal"), { code: "ENOENT" });
    await assert.rejects(app.persistence.status({ operationId: ids[0] }, { owner: "foreign-journal-owner" }),
        { code: "NATIVE_RETENTION_OPERATION_OWNER" });
    const changeIdentity = id => {
        const database = new DatabaseSync(file);
        try { database.prepare("UPDATE archive_info SET archive_id=?").run(id); } finally { database.close(); }
    };
    changeIdentity(randomUUID());
    try {
        await assert.rejects(app.persistence.beginSegmented({ operationId: randomUUID() }, app.admission),
            { code: "NATIVE_RETENTION_RECEIPT_ARCHIVE_INVALID" });
    } finally { changeIdentity(archiveId); }
    assert.equal((await app.replaceAccount()).outcome, "completed");
    await assert.rejects(app.persistence.beginSegmented({ operationId: ids[0] }, app.admission),
        { code: "NATIVE_RETENTION_OPERATION_OWNER" });
});

const admissionEvidence = Object.freeze({ schemaVersion: 1, method: "GET", resourceType: "document",
    publicRoute: "other", owner: "owned-frame", original: true, navigation: true, predicate: "document-scope", stage: "protocol",
    document: Object.freeze({ originClass: "admitted-app", originLabel: "m365-app", routeLabel: "unknown", clause: "unlisted-app-path" }) });
const admissionFailure = () => withNativeFailureAdmission(withNativeFailurePredicate(
    Object.assign(new Error("PRIVATE_SOURCE_VALUE"), { code: "NATIVE_SOURCE_REQUEST_UNQUALIFIED" }),
    "protocol", "request-admission"), admissionEvidence);

for (const evidenceKind of ["legacy", "admission", "protocol", "public-script"])
test(`original failed collection evidence survives restart and completed receipt archival without becoming public authority${evidenceKind !== "legacy" ? " with " + evidenceKind : ""}`, async t => {
    const withAdmission = evidenceKind === "admission", withProtocol = evidenceKind === "protocol", withScript = evidenceKind === "public-script";
    const app = await setup(t);
    const pending = await app.persistence.beginSegmented({ operationId: randomUUID() }, app.admission);
    const failure = nativeFailureDetails(withScript ? Object.assign(new Error("PRIVATE_SOURCE_VALUE"), {
        code: "NATIVE_TOOL_TRANSPORT_ENTRY_UNQUALIFIED", publicCoworkScript: "coworker.8d98ec00.js",
    }) : withProtocol ? nativeProtocolFailure("network-record-missing", null, {
        observation: { source: "network", terminal: "failed" },
    }) : withAdmission ? admissionFailure() : withNativeFailurePredicate(
        Object.assign(new Error("PRIVATE_SOURCE_VALUE"), { code: "NATIVE_FAVICON_UNQUALIFIED" }),
        "protocol", "favicon-request-initiator"), "acquisition");
    await app.lifecycle.expire(pending.ticket.lease);
    assert.equal(await app.persistence.recordFailure(pending.ticket, failure), true);
    assert.equal(await app.persistence.recordFailure(pending.ticket, nativeFailureDetails(new Error("PRIVATE_CLEANUP"), "completion")), false);
    await assert.rejects(app.persistence.commitSegmented(pending.ticket, []), { code: "NATIVE_RETENTION_TICKET_FAILED" });
    await assert.rejects(app.persistence.recordFailure({ ...pending.ticket }, failure), { code: "NATIVE_RETENTION_TICKET_INVALID" });
    app.persistence.retire(pending.ticket);
    await app.restartPersistence();
    const record = (await loadBoardState(app.context)).nativeRetention.receipts.find(row => row.operationId === pending.ticket.operationId);
    assert.deepEqual(record.firstFailure.predicate, failure.predicate);
    assert.equal(record.firstFailure.code, failure.code);
    assert.equal(record.firstFailure.publicCoworkScript, failure.publicCoworkScript);
    assert.deepEqual(record.firstFailure.admission, failure.admission);
    assert.deepEqual(record.firstFailure.protocolStop, failure.protocolStop);
    const original = await app.persistence.beginSegmented({ operationId: pending.ticket.operationId }, app.admission);
    assert.equal(original.kind, "unresolved");
    assert.equal(original.receipt.status, "unknown");
    assert.equal(original.receipt.firstFailure, undefined);
    const calls = app.providerCalls;
    assert.equal((await app.persistence.status({ operationId: pending.ticket.operationId }, { owner: app.owner })).receipt.firstFailure, undefined);
    assert.equal(app.providerCalls, calls);

    assert.equal((await app.lifecycle.command(app.owner, {
        action: "microsoft-connect", operationId: randomUUID(), generation: (await app.lifecycle.status()).generation,
        replace: false,
    }, () => true)).outcome, "completed");
    const successful = await app.persistence.beginSegmented({ operationId: randomUUID() }, app.admission);
    const receipt = await app.persistence.commitSegmented(successful.ticket, app.source);
    const completion = nativeFailureDetails(withProtocol ? nativeProtocolFailure("protocol-coverage", null)
        : withAdmission ? admissionFailure() : new Error("PRIVATE_COMPLETION_VALUE"), "completion");
    const unchanged = await app.bytes();
    await assert.rejects(app.persistence.recordFailure(successful.ticket, {
        ...completion, predicate: { ...completion.predicate, value: "PRIVATE_VALUE" },
    }), { code: "NATIVE_RETENTION_FAILURE_INVALID" });
    assert.deepEqual(await app.bytes(), unchanged);
    if (withAdmission) {
        for (const admission of [null, undefined, { ...admissionEvidence, url: "PRIVATE_URL" },
            { ...admissionEvidence, publicRoute: "https://PRIVATE_URL" }, { ...admissionEvidence, predicate: "PRIVATE_PREDICATE" },
            { ...admissionEvidence, owner: "PRIVATE_ACCOUNT" }]) {
            await assert.rejects(app.persistence.recordFailure(successful.ticket, { ...completion, admission }),
                { code: "NATIVE_RETENTION_FAILURE_INVALID" });
            assert.deepEqual(await app.bytes(), unchanged);
        }
    }
    if (withProtocol) {
        await assert.rejects(app.persistence.recordFailure(successful.ticket, { ...completion,
            protocolStop: { ...completion.protocolStop, rawUrl: "PRIVATE_URL" } }), { code: "NATIVE_RETENTION_FAILURE_INVALID" });
        assert.deepEqual(await app.bytes(), unchanged);
    }
    assert.equal(await app.persistence.recordFailure(successful.ticket, completion), true);
    app.persistence.retire(successful.ticket);
    const ids = Array.from({ length: 126 }, () => randomUUID());
    await updateBoardState(app.context, state => {
        const saved = state.nativeRetention.receipts.find(row => row.operationId === successful.ticket.operationId);
        state.nativeRetention.receipts.push(...ids.map(operationId => ({ ...structuredClone(saved), operationId })));
    });
    const next = await app.persistence.beginSegmented({ operationId: randomUUID() }, app.admission);
    app.persistence.retire(next.ticket);
    await app.restartPersistence();
    const state = await loadBoardState(app.context);
    const archived = await readArchivedNativeReceipt(app.context, state.nativeRetention, ids[0]);
    assert.equal(archived.status, "committed");
    assert.deepEqual(archived.firstFailure.predicate, completion.predicate);
    assert.deepEqual(archived.firstFailure.admission, completion.admission);
    assert.deepEqual(archived.firstFailure.protocolStop, completion.protocolStop);
    assert.equal(validNativeFailure(archived.firstFailure), true);
    assert.equal((await app.persistence.beginSegmented({ operationId: ids[0] }, app.admission)).kind, "committed");
    const recovered = (await app.persistence.status({ operationId: ids[0] }, { owner: app.owner })).receipt;
    assert.equal(recovered.firstFailure, undefined);
    assert.equal(recovered.snapshot, receipt.snapshot);
    const before = await app.bytes();
    for (const predicate of [{ ...failure.predicate, name: "PRIVATE_VALUE" }, { ...failure.predicate, query: "PRIVATE_QUERY" }]) {
        await assert.rejects(updateBoardState(app.context, state => {
            state.nativeRetention.receipts[0].firstFailure.predicate = predicate;
        }), { code: "NATIVE_RETENTION_STATE_INVALID" });
        assert.deepEqual(await app.bytes(), before);
    }
    if (withAdmission) {
        await assert.rejects(updateBoardState(app.context, state => {
            state.nativeRetention.receipts[0].firstFailure.admission = { ...admissionEvidence, headers: "PRIVATE_HEADER" };
        }), { code: "NATIVE_RETENTION_STATE_INVALID" });
        assert.deepEqual(await app.bytes(), before);
    }
    const file = path.join(app.context.dataDir, "collector", "native-receipts", `${state.nativeRetention.receiptArchive.id}.sqlite`);
    const database = new DatabaseSync(file);
    try {
        const invalid = JSON.stringify({ ...archived, firstFailure: withProtocol
            ? { ...archived.firstFailure, protocolStop: { ...completion.protocolStop, reason: "PRIVATE_REASON" } } : withAdmission
            ? { ...archived.firstFailure, admission: { ...admissionEvidence, query: "PRIVATE_QUERY" } }
            : { ...archived.firstFailure, privateUrl: "https://example.invalid/private" } });
        database.prepare("UPDATE receipts SET receipt_json=?,receipt_hash=? WHERE operation_id=?")
            .run(invalid, createHash("sha256").update(invalid).digest("hex"), ids[0]);
    } finally { database.close(); }
    await assert.rejects(app.persistence.status({ operationId: ids[0] }, { owner: app.owner }),
        { code: "NATIVE_RETENTION_RECEIPT_ARCHIVE_UNAVAILABLE" });
    assert.doesNotMatch(JSON.stringify(state), /PRIVATE_SOURCE|PRIVATE_CLEANUP|PRIVATE_COMPLETION|PRIVATE_QUERY/);
});

test("native backfill registration pins the first window before acquisition and unfinished publication", async t => {
    const app = await setup(t, { backfillTracking: true });
    const first = await app.persistence.beginSegmented({ operationId: randomUUID() }, app.admission);
    const registered = (await loadBoardState(app.context)).nativeRetention;
    assert.equal(registered.backfill?.length, 1, "The fixed window must survive before any source acquisition.");
    const checkpoint = registered.backfill[0], window = checkpoint.window;
    assert.equal(window.to, registered.receipts[0].registeredAt);
    assert.deepEqual(first.ticket.backfill, checkpoint);
    assert.equal(nativeBackfillSummary(checkpoint).state, "started");
    await app.persistence.commitSegmented(first.ticket, app.source);
    app.persistence.retire(first.ticket);
    await app.restartPersistence();
    const calls = app.providerCalls;
    assert.equal((await app.persistence.beginSegmented({ operationId: first.ticket.operationId }, app.admission)).kind, "committed");
    assert.equal(app.providerCalls, calls, "Original receipt recovery must not acquire again.");
    assert.deepEqual((await app.persistence.status({}, { owner: app.owner })).backfill.window, window);
    const next = await app.persistence.beginSegmented({ operationId: randomUUID() }, app.admission);
    assert.deepEqual(next.ticket.backfill.window, window);
    const resumed = createNativeBackfill(checkpoint.accountRef, 30, ["chat", "cowork"], checkpoint.privacyRevision,
        next.ticket.backfill, Date.parse(window.to) + 60000);
    assert.deepEqual(resumed.window, window, "A later source read cannot shift an unfinished registered window.");
    const shifted = structuredClone(resumed);
    for (const key of ["from", "to"]) shifted.window[key] = new Date(Date.parse(window[key]) + 1000).toISOString();
    const invalid = attachNativeBackfill(structuredClone(app.source), shifted);
    await app.persistence.commitSegmented(next.ticket, invalid);
    const comparison = await app.persistence.compareCommittedSource(next.ticket, invalid);
    const before = await app.bytes();
    await assert.rejects(app.persistence.recordBackfill(next.ticket, invalid, comparison), { code: "NATIVE_BACKFILL_SCOPE_CHANGED" });
    assert.deepEqual(await app.bytes(), before);
    const valid = attachNativeBackfill(structuredClone(app.source), resumed);
    await app.persistence.recordBackfill(next.ticket, valid, comparison);
    assert.deepEqual((await app.persistence.status({}, { owner: app.owner })).backfill.window, window);
    app.persistence.retire(next.ticket);
});

test("backfill checkpoints remain idempotent across restart and keep a qualified boundary distinct from an exhausted suffix", async t => {
    const app = await setup(t);
    const initial = await app.persistence.beginSegmented({ operationId: randomUUID() }, app.admission);
    const make = (ticket, records, qualified = false) => {
        const progress = createNativeBackfill(ticket.lease.partition, 30, ["chat", "cowork"],
            ticket.configuration.privacyRevision, qualified ? null : ticket.backfill, Date.now());
        for (const source of progress.sources) {
            source.controlObserved = true; source.initial = qualified ? "empty" : "present";
            source.startQualified = qualified; source.exhausted = true; source.pages = ["a".repeat(64)];
            source.chain = "b".repeat(64); source.chainPages = 1;
            const activity = Date.now() - 1000;
            if (source.surface === "cowork" && records.length) source.histories = [{
                key: nativeRetentionHash(["cowork", records[0].scope.conversationId]),
                activity, handledActivity: activity, handledThrough: Date.parse(progress.window.to), state: "handled",
            }];
        }
        return { progress, records: attachNativeBackfill(records, progress) };
    };
    const first = make(initial.ticket, structuredClone(app.source));
    await app.persistence.commitSegmented(initial.ticket, first.records);
    assert.equal((await loadBoardState(app.context)).nativeRetention.backfill, undefined, "A commit alone is not confirmed backfill coverage.");
    const comparison = await app.persistence.compareCommittedSource(initial.ticket, first.records);
    await app.persistence.recordBackfill(initial.ticket, first.records, comparison);
    const state = await loadBoardState(app.context), checkpoint = state.nativeRetention.backfill[0];
    const summary = nativeBackfillSummary(checkpoint);
    assert.equal(summary.state, "unqualified");
    assert.equal(summary.sources.find(row => row.surface === "cowork").handled, 1);
    assert.equal(summary.sources.find(row => row.surface === "chat").eligible, 0);
    const bytes = await app.bytes();
    const publicStatus = await app.persistence.status({ operationId: initial.ticket.operationId }, { owner: app.owner });
    assert.equal(publicStatus.receipt.backfill, undefined);
    const ordinaryStatus = await app.persistence.status({});
    assert.equal(ordinaryStatus.receipt, null);
    for (const value of [ordinaryStatus, publicStatus]) {
        assert.doesNotThrow(() => createCollectionStatus().persistence({ nativePersistence: value }));
        for (const backfill of [
            { ...value.backfill, state: "covered" },
            { ...value.backfill, rawCursor: "not-an-authority" },
            { ...value.backfill, sources: value.backfill.sources.map(row => ({ ...row, pending: row.pending + 1 })) },
        ]) assert.throws(() => createCollectionStatus().persistence({ nativePersistence: { ...value, backfill } }), /progress/i);
    }
    await app.persistence.recordBackfill(initial.ticket, first.records, comparison);
    assert.deepEqual(await app.bytes(), bytes);
    await assert.rejects(updateBoardState(app.context, state => { delete state.nativeRetention.backfill; }),
        { code: "NATIVE_RETENTION_STATE_INVALID" });
    assert.deepEqual(await app.bytes(), bytes);
    app.persistence.retire(initial.ticket);
    await app.restartPersistence();
    const next = await app.persistence.beginSegmented({ operationId: randomUUID() }, app.admission);
    assert.deepEqual(next.ticket.backfill, checkpoint);
    const empty = make(next.ticket, [], true);
    await app.persistence.commitSegmented(next.ticket, empty.records);
    const emptyComparison = await app.persistence.compareCommittedSource(next.ticket, empty.records);
    await app.persistence.recordBackfill(next.ticket, empty.records, emptyComparison);
    const covered = (await app.persistence.status({}, { owner: app.owner })).backfill;
    assert.equal(covered.state, "covered", "This synthetic source witness tests conditional coverage mechanics, not live provider qualification.");
    assert.ok(covered.sources.every(source => source.eligible === 0 && source.pending === 0 && source.unreadable === 0));
    assert.throws(() => validateNativeBackfillSummary({ ...covered, sources: covered.sources.map(row => ({ ...row, startQualified: false })) }),
        { code: "NATIVE_BACKFILL_INVALID" });
    app.persistence.retire(next.ticket);
    for (const [surfaces, windowDays] of [[["cowork"], 7], [["chat", "cowork"], 30]]) {
        await app.persistence.configure({
            expectedRevision: (await loadBoardState(app.context)).nativeRetention.configurationRevision, surfaces, windowDays,
        }, app.admission);
        await app.lifecycle.updateCollection({ paused: false, windowDays });
        assert.equal((await app.persistence.status({}, { owner: app.owner })).backfill, undefined,
            "An old source/window/privacy checkpoint must not be presented as the new scope.");
    }
    const interrupted = await app.persistence.beginSegmented({ operationId: randomUUID() }, app.admission);
    const unfinished = make(interrupted.ticket, structuredClone(app.source));
    unfinished.progress.sources.find(row => row.surface === "cowork").histories[0].state = "unreadable";
    unfinished.progress.sources.find(row => row.surface === "cowork").stops.push("unreadable-history", "time-budget", "byte-budget");
    const failureProgress = attachNativeBackfill([], unfinished.progress);
    await app.lifecycle.expire(interrupted.ticket.lease);
    await app.persistence.recordFailure(interrupted.ticket, nativeFailureDetails(new Error("read failed"), "acquisition"), failureProgress);
    app.persistence.retire(interrupted.ticket);
    await app.restartPersistence();
    const failed = (await app.persistence.status({}, { owner: app.owner })).backfill;
    assert.equal(failed.state, "progressing");
    assert.equal(failed.sources.find(row => row.surface === "cowork").unreadable, 1);
    assert.deepEqual(failed.sources.find(row => row.surface === "cowork").stops, ["unreadable-history", "time-budget", "byte-budget"]);
    const changed = createNativeBackfill(checkpoint.accountRef, 7, ["cowork"], checkpoint.privacyRevision + 1, checkpoint);
    assert.deepEqual(changed.sources.map(row => row.histories.length), [0]);
    assert.equal(changed.windowDays, 7);
    assert.equal(changed.sources[0].startQualified, false);
});

for (const surface of ["cowork", "chat"])
for (const established of [false, true])
for (const outcome of ["acquisition-failure", "write-refused", "matched-commit"])
test(`${surface} rotation preserves confirmed publication: ${outcome}, prior checkpoint ${established}`, async t => {
    const app = await setup(t, { backfillTracking: true, sourceSurface: surface }), cursorKey = surface + "Cursor";
    const initial = await app.persistence.beginSegmented({ operationId: randomUUID() }, app.admission);
    const progress = structuredClone(initial.ticket.backfill);
    const source = progress.sources.find(row => row.surface === surface);
    const originalCursor = { ...(surface === "cowork" ? { parentAfter: "a".repeat(64) } : {}), referenceAfter: "b".repeat(64) };
    const advancedCursor = { ...(surface === "cowork" ? { parentAfter: "c".repeat(64) } : {}), referenceAfter: "d".repeat(64) };
    if (established) source[cursorKey] = originalCursor;
    const activity = Date.parse(progress.window.to) - 1000;
    Object.assign(source, { controlObserved: true, initial: "absent", pages: ["1".repeat(64)],
        chain: "2".repeat(64), chainPages: 1, stops: ["membership-unqualified"],
        histories: [{ key: nativeRetentionHash([surface, app.source[0].scope.conversationId]),
            activity, handledActivity: activity, handledThrough: Date.parse(progress.window.to), state: "handled" }] });
    const records = attachNativeBackfill(structuredClone(app.source), progress);
    await app.persistence.commitSegmented(initial.ticket, records);
    const initialComparison = await app.persistence.compareCommittedSource(initial.ticket, records);
    assert.equal(initialComparison.status, "matched");
    await app.persistence.recordBackfill(initial.ticket, records, initialComparison);
    app.persistence.retire(initial.ticket);
    const committed = (await loadBoardState(app.context)).nativeRetention;
    const priorReceipt = committed.receipts.find(row => row.operationId === initial.ticket.operationId);

    const pending = await app.persistence.beginSegmented({ operationId: randomUUID() }, app.admission);
    const tentative = structuredClone(pending.ticket.backfill);
    const next = tentative.sources.find(row => row.surface === surface);
    next[cursorKey] = advancedCursor;
    next.pages.push("3".repeat(64)); next.chain = "4".repeat(64); next.chainPages++;
    next.histories[0].activity++;
    next.histories[0].handledActivity = next.histories[0].activity;
    const nextRecords = attachNativeBackfill(structuredClone(app.source), tentative);
    let failure = Object.assign(new Error("Invented acquisition failure."), { code: "NATIVE_SOURCE_HISTORY_UNQUALIFIED" });
    if (outcome === "write-refused") {
        await app.lifecycle.updateCollection({ paused: true, windowDays: 30 });
        await assert.rejects(app.persistence.commitSegmented(pending.ticket, nextRecords), error => {
            failure = error;
            assert.equal(error.code, "lease-invalid");
            return true;
        });
    } else if (outcome === "matched-commit") {
        await app.persistence.commitSegmented(pending.ticket, nextRecords);
        assert.deepEqual((await loadBoardState(app.context)).nativeRetention.backfill[0].sources
            .find(row => row.surface === surface)[cursorKey], established ? originalCursor : undefined,
        "A content commit alone does not publish an advanced rotation checkpoint.");
        const comparison = await app.persistence.compareCommittedSource(pending.ticket, nextRecords);
        assert.equal(comparison.status, "matched");
        await app.persistence.recordBackfill(pending.ticket, nextRecords, comparison);
        assert.deepEqual((await loadBoardState(app.context)).nativeRetention.backfill[0].sources
            .find(row => row.surface === surface)[cursorKey], advancedCursor);
        next[cursorKey] = { ...(surface === "cowork" ? { parentAfter: "e".repeat(64) } : {}), referenceAfter: "f".repeat(64) };
    }
    const beforeFailure = (await loadBoardState(app.context)).nativeRetention;
    next.histories.push({ key: "5".repeat(64), activity, handledActivity: null, handledThrough: null, state: "unreadable" });
    next.stops.push("time-budget", "unreadable-history");
    const diagnostics = attachNativeBackfill([], tentative);
    const detail = nativeFailureDetails(failure, outcome === "acquisition-failure" ? "acquisition" : "completion");
    assert.equal(await app.persistence.recordFailure(pending.ticket, detail, diagnostics), true);
    const failed = (await loadBoardState(app.context)).nativeRetention;
    const savedSource = failed.backfill[0].sources.find(row => row.surface === surface);
    const expectedCursor = outcome === "matched-commit" ? advancedCursor : established ? originalCursor : undefined;
    assert.deepEqual(savedSource[cursorKey], expectedCursor);
    assert.equal(Object.hasOwn(savedSource, cursorKey), expectedCursor !== undefined,
        "An originally absent checkpoint must remain absent, not become a tentative checkpoint.");
    assert.deepEqual(savedSource.pages, next.pages);
    assert.deepEqual(savedSource.stops, next.stops);
    assert.equal(savedSource.histories[1].state, "unreadable");
    assert.equal(savedSource.histories[0].state, outcome === "matched-commit" ? "handled" : "pending");
    const confirmedHistory = beforeFailure.backfill[0].sources.find(row => row.surface === surface).histories[0];
    assert.equal(savedSource.histories[0].handledActivity, confirmedHistory.handledActivity);
    assert.equal(savedSource.histories[0].handledThrough, confirmedHistory.handledThrough);
    assert.deepEqual(failed.partitions, beforeFailure.partitions, "Failure diagnostics cannot rewind or write retained evidence.");
    assert.deepEqual(failed.receipts.find(row => row.operationId === initial.ticket.operationId), priorReceipt);
    const receipt = failed.receipts.find(row => row.operationId === pending.ticket.operationId);
    assert.equal(receipt.status, outcome === "matched-commit" ? "committed" : "registered");
    assert.equal(receipt.firstFailure.code, detail.code);
    assert.equal(receipt.backfill.sources.find(row => row.surface === surface).unreadable, 1);
    assert.equal(await app.persistence.recordFailure(pending.ticket, detail, diagnostics), false);
    app.persistence.retire(pending.ticket);
    const calls = app.providerCalls;
    await app.restartPersistence();
    assert.deepEqual((await loadBoardState(app.context)).nativeRetention, failed);
    assert.equal(app.providerCalls, calls, "Restart and original failure publication cannot replay source acquisition.");
});

test("Delete all clears discovery-only membership even when no native observations were collected", async t => {
    const app = await setup(t), pending = await app.persistence.beginSegmented({ operationId: randomUUID() }, app.admission);
    const progress = createNativeBackfill(pending.ticket.lease.partition, 30, ["chat", "cowork"], pending.ticket.configuration.privacyRevision, null);
    const source = progress.sources.find(row => row.surface === "chat");
    const member = "f".repeat(64);
    source.controlObserved = true; source.initial = "present"; source.pages = ["a".repeat(64)]; source.chain = "b".repeat(64); source.chainPages = 1;
    source.histories = [{ key: member, activity: Date.now() - 1000, handledActivity: null, handledThrough: null, state: "pending" }];
    const records = attachNativeBackfill([], progress);
    await app.persistence.commitSegmented(pending.ticket, records);
    const comparison = await app.persistence.compareCommittedSource(pending.ticket, records);
    await app.persistence.recordBackfill(pending.ticket, records, comparison);
    app.persistence.retire(pending.ticket);
    const late = await app.persistence.beginSegmented({ operationId: randomUUID() }, app.admission);
    const backup = path.join(app.context.dataDir, "prior-state.snapshot.json");
    await filesystem.writeFile(backup, await app.bytes());
    const deletion = createDeletionController(app.context), admission = await app.persistence.localActivityDeletionAdmission(app.admission);
    const preview = await deletion.preview(app.owner, { scope: "all" }, admission);
    assert.equal(preview.counts.records, 0);
    assert.ok(preview.counts.localCopies >= 1);
    assert.equal((await deletion.confirm(app.owner, { operationId: preview.operationId, confirmed: true }, admission)).phase, "complete");
    const state = await loadBoardState(app.context);
    assert.deepEqual(state.nativeRetention.backfill, []);
    assert.equal(JSON.stringify(state).includes(member), false);
    const recovered = JSON.parse(await readFile(backup, "utf8"));
    assert.deepEqual(recovered.nativeRetention.backfill, []);
    assert.equal(JSON.stringify(recovered).includes(member), false);
    await app.lifecycle.expire(late.ticket.lease);
    const failure = nativeFailureDetails(admissionFailure(), "acquisition");
    assert.equal(await app.persistence.recordFailure(late.ticket, failure, records), true);
    const afterFailure = await loadBoardState(app.context);
    assert.deepEqual(afterFailure.nativeRetention.backfill, [], "Late diagnostics cannot restore deleted discovery membership.");
    assert.equal(JSON.stringify(afterFailure).includes(member), false);
    assert.equal(afterFailure.nativeRetention.receipts.find(row => row.operationId === late.ticket.operationId).firstFailure.code, failure.code);
    assert.deepEqual(afterFailure.nativeRetention.receipts.find(row => row.operationId === late.ticket.operationId).firstFailure.admission, admissionEvidence);
    const restored = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
        import { loadBoardState } from './lib/store.mjs';
        const state = await loadBoardState({ dataDir: process.argv[1] }, { readOnly: true });
        console.log(JSON.stringify({ pid: process.pid, backfill: state.nativeRetention.backfill,
            failure: state.nativeRetention.receipts.find(row => row.operationId === process.argv[2]).firstFailure,
            deletedMemberPresent: JSON.stringify(state).includes(process.argv[3]) }));
    `, app.context.dataDir, late.ticket.operationId, member], { timeout: 10000, maxBuffer: 65536, windowsHide: true });
    const reopened = JSON.parse(restored.stdout);
    assert.notEqual(reopened.pid, process.pid);
    assert.deepEqual(reopened.backfill, []);
    assert.equal(reopened.deletedMemberPresent, false);
    assert.equal(reopened.failure.code, failure.code);
    assert.deepEqual(reopened.failure.admission, admissionEvidence);
    const restarted = createNativeBackfill(progress.accountRef, progress.windowDays, ["chat", "cowork"], progress.privacyRevision,
        progress, Date.now(), afterFailure.deletion.epoch);
    assert.ok(restarted.sources.every(row => row.histories.length === 0 && row.pages.length === 0 && !row.exhausted),
        "A restored checkpoint from an older deletion version cannot seed a fresh round.");
    app.persistence.retire(late.ticket);
    assert.equal((await app.persistence.status({}, { owner: app.owner })).backfill, undefined);
});
test("settled receipt archival continues beyond 1024 cycles without losing original recovery or unresolved proof", { timeout: 600000 }, async t => {
    const app = await setup(t);
    const begin = async () => (await app.persistence.beginSegmented({ operationId: randomUUID() }, app.admission)).ticket;
    const first = await begin(), original = await app.persistence.commitSegmented(first, app.source);
    app.persistence.retire(first);
    const held = await begin();
    await app.persistence.commitSegmented(held, []);
    const unknown = await begin();
    app.persistence.retire(unknown);
    const originalPrivate = (await loadBoardState(app.context)).nativeRetention.receipts.find(row => row.operationId === first.operationId);
    let archiveFile, archiveId, interrupted = false;
    const mutateArchive = work => {
        const database = new DatabaseSync(archiveFile);
        try { work(database); } finally { database.close(); }
    };
    const replaceOriginal = receipt => mutateArchive(database => {
        const text = JSON.stringify(receipt);
        assert.equal(database.prepare("UPDATE receipts SET receipt_json=?,receipt_hash=? WHERE operation_id=?")
            .run(text, createHash("sha256").update(text).digest("hex"), first.operationId).changes, 1);
    });
    for (let cycle = 0; cycle < 1028; cycle++) {
        if (cycle === 125) {
            const rename = filesystem.rename;
            const fault = t.mock.method(filesystem, "rename", async (from, to) => {
                if (!interrupted && String(to).endsWith(`${BOARD_ID}.state.json`)) {
                    const staged = JSON.parse(await readFile(from, "utf8"));
                    if (staged.nativeRetention?.receiptArchive && staged.nativeRetention.receipts.length < 128) {
                        interrupted = true;
                        throw Object.assign(new Error("Fixture compaction publication interrupted."), { code: "EIO" });
                    }
                }
                return rename(from, to);
            });
            syncBuiltinESMExports();
            try { await assert.rejects(begin(), { code: "EIO" }); }
            finally { fault.mock.restore(); syncBuiltinESMExports(); }
            const intact = await loadBoardState(app.context);
            assert.equal(interrupted, true);
            assert.equal(intact.nativeRetention.receipts.length, 128);
            assert.ok(intact.nativeRetention.receipts.some(row => row.operationId === first.operationId));
            archiveId = intact.nativeRetention.receiptArchive.id;
            archiveFile = path.join(app.context.dataDir, "collector", "native-receipts", `${archiveId}.sqlite`);
            assert.equal((await app.persistence.status({ operationId: first.operationId }, { owner: app.owner })).receipt.status, "committed");
            replaceOriginal({ ...originalPrivate, generation: originalPrivate.generation + 1 });
            await assert.rejects(begin(), { code: "NATIVE_RETENTION_RECEIPT_ARCHIVE_INVALID" });
            assert.equal((await loadBoardState(app.context)).nativeRetention.receipts.length, 128);
            replaceOriginal(originalPrivate);
        }
        const ticket = await begin();
        assert.equal((await app.persistence.commitSegmented(ticket, [])).status, "committed");
        app.persistence.retire(ticket);
        if ((cycle + 1) % 256 === 0) t.diagnostic(`${cycle + 1} bounded empty cycles durably committed.`);
    }
    const state = await loadBoardState(app.context);
    assert.equal(state.nativeRetention.receiptArchive.id, archiveId, "Interrupted compaction must reuse its anchored archive.");
    assert.ok(state.nativeRetention.receipts.length < 128);
    assert.equal(state.nativeRetention.receipts.some(row => row.operationId === first.operationId), false);
    assert.ok(state.nativeRetention.receipts.some(row => row.operationId === held.operationId), "Unretired ticket proof stays inline.");
    assert.equal(state.nativeRetention.receipts.find(row => row.operationId === unknown.operationId).status, "registered");
    const pointer = state.nativeRetention.partitions[0];
    assert.ok(state.nativeRetention.receipts.some(row => row.operationId === pointer.lastOperationId));
    const before = await app.bytes(), calls = app.providerCalls;
    assert.deepEqual((await app.persistence.status({ operationId: first.operationId }, { owner: app.owner })).receipt, original);
    const recovered = await app.persistence.beginSegmented({ operationId: first.operationId }, app.admission);
    assert.equal(recovered.kind, "committed");
    assert.deepEqual(recovered.receipt, original);
    assert.deepEqual(await app.bytes(), before, "Archived recovery must not register or collect another operation.");
    assert.equal(app.providerCalls, calls);
    await assert.rejects(app.persistence.status({ operationId: first.operationId }, { owner: "foreign-receipt-owner" }),
        { code: "NATIVE_RETENTION_OPERATION_OWNER" });
    await assert.rejects(updateBoardState(app.context, state => { delete state.nativeRetention.receiptArchive; }),
        { code: "NATIVE_RETENTION_STATE_INVALID" });
    await filesystem.rename(archiveFile, archiveFile + ".missing");
    try {
        await assert.rejects(begin(), { code: "NATIVE_RETENTION_RECEIPT_ARCHIVE_UNAVAILABLE" });
        await assert.rejects(app.persistence.status({ operationId: first.operationId }, { owner: app.owner }),
            { code: "NATIVE_RETENTION_RECEIPT_ARCHIVE_UNAVAILABLE" });
    } finally { await filesystem.rename(archiveFile + ".missing", archiveFile); }
    mutateArchive(database => database.prepare("UPDATE archive_info SET archive_id=?").run(randomUUID()));
    try { await assert.rejects(begin(), { code: "NATIVE_RETENTION_RECEIPT_ARCHIVE_INVALID" }); }
    finally { mutateArchive(database => database.prepare("UPDATE archive_info SET archive_id=?").run(archiveId)); }
    mutateArchive(database => database.prepare("UPDATE receipts SET receipt_hash=? WHERE operation_id=?").run("0".repeat(64), first.operationId));
    try {
        await assert.rejects(app.persistence.beginSegmented({ operationId: first.operationId }, app.admission),
            { code: "NATIVE_RETENTION_RECEIPT_ARCHIVE_INVALID" });
    } finally { replaceOriginal(originalPrivate); }
    app.persistence.retire(held);
    await app.restartPersistence();
    assert.deepEqual((await app.persistence.status({ operationId: first.operationId }, { owner: app.owner })).receipt, original);
    assert.equal((await app.persistence.status({ operationId: unknown.operationId }, { owner: app.owner })).receipt.status, "unknown");
    assert.equal((await app.replaceAccount()).outcome, "completed");
    await assert.rejects(app.persistence.status({ operationId: first.operationId }, { owner: app.owner }),
        { code: "NATIVE_RETENTION_OPERATION_OWNER" });
});

test("committed comparison binds the real ticket and works after UI release without a new lookup or write", async t => {
    const app = await setup(t), ticket = await app.begin();
    await app.persistence.commit(ticket, app.source);
    app.releaseRequester();
    const before = await app.bytes(), checks = app.requesterChecks, calls = app.providerCalls;
    const result = await app.persistence.compareCommittedSource(ticket, app.source);
    assert.deepEqual(result, { schemaVersion: 1, status: "matched", sourceObservationInputs: app.source.length,
        retainedObservationInputs: app.source.length, suppressedObservations: 0 });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(app.requesterChecks, checks);
    assert.equal(app.providerCalls, calls);
    assert.deepEqual(await app.bytes(), before);
    assert.doesNotMatch(JSON.stringify(result), /invented|owner|operationId|partition|fingerprint|snapshot/);
    assert.deepEqual(await app.persistence.compareCommittedSource(ticket, app.source),
        { schemaVersion: 1, status: "unverified", reason: "comparison-already-attempted" });
    assert.deepEqual(await app.persistence.compareCommittedSource({ ...ticket }, app.source),
        { schemaVersion: 1, status: "unverified", reason: "ticket-unavailable" });
});

test("comparison preserves prior history while matching changed variants and new capture provenance", async t => {
    const app = await setup(t), first = await app.begin();
    await app.persistence.commit(first, app.source);
    app.persistence.retire(first);
    const changed = [structuredClone(app.source.find(row => row.record.event === "ts"))];
    changed[0].capture.captureId += "-changed";
    changed[0].qualifiedFields.input.value = { query: "A changed non-secret input." };
    changed[0].record.data.inp = JSON.stringify(changed[0].qualifiedFields.input.value);
    const next = await app.begin();
    await app.persistence.commit(next, changed);
    const before = await app.bytes();
    assert.equal((await app.retained()).records.length, app.source.length + 1);
    assert.deepEqual(await app.persistence.compareCommittedSource(next, changed),
        { schemaVersion: 1, status: "matched", sourceObservationInputs: 1, retainedObservationInputs: 1, suppressedObservations: 0 });
    assert.deepEqual(await app.bytes(), before);
});

test("complete-document comparison catches missing provenance that the retained view cannot distinguish", async t => {
    const app = await setup(t), source = structuredClone(app.source);
    const overlap = structuredClone(source[2]);
    overlap.ordering.pageOrdinal++;
    source.push(overlap);
    const ticket = await app.begin(), receipt = await app.persistence.commit(ticket, source);
    const beforeView = (await app.retained()).records;
    const document = JSON.parse(await readFile(path.join(app.context.dataDir, "private-evidence", receipt.snapshot + ".json"), "utf8"));
    const variant = document.observations.flatMap(observation => observation.variants).find(item => item.provenance.length === 2);
    assert.ok(variant);
    variant.provenance.pop();
    validateNativeRetainedDocument(document);
    const file = await stagePrivateEvidence(app.context, JSON.stringify(document));
    await updateBoardState(app.context, state => {
        state.nativeRetention.partitions[0].file = file;
        state.nativeRetention.receipts.find(item => item.operationId === receipt.operationId).snapshot = file.slice(0, -5);
    });
    assert.deepEqual((await app.retained()).records, beforeView);
    const before = await app.bytes();
    assert.deepEqual(await app.persistence.compareCommittedSource(ticket, source),
        { schemaVersion: 1, status: "unverified", reason: "retained-source-mismatch" });
    assert.deepEqual(await app.bytes(), before);
});

test("comparison can qualify a real committed operation even when its post-save readback threw", async t => {
    const app = await setup(t), ticket = await app.begin(), original = filesystem.open;
    let rejected = false;
    const mock = t.mock.method(filesystem, "open", async (file, ...args) => {
        if (!rejected && args[0] === "r" && path.dirname(String(file)) === path.join(app.context.dataDir, "private-evidence")) {
            rejected = true;
            throw Object.assign(new Error("Test readback unavailable."), { code: "EIO" });
        }
        return original(file, ...args);
    });
    syncBuiltinESMExports();
    try { await assert.rejects(app.persistence.commit(ticket, app.source), { code: "EIO" }); }
    finally { mock.mock.restore(); syncBuiltinESMExports(); }
    app.releaseRequester();
    const before = await app.bytes();
    assert.equal((await app.persistence.compareCommittedSource(ticket, app.source)).status, "matched");
    assert.deepEqual(await app.bytes(), before);
});

test("suppressed source is verified as deletion, never as newly retained content", async t => {
    const app = await setup(t), first = await app.begin();
    await app.persistence.commit(first, app.source);
    app.persistence.retire(first);
    const deletion = createDeletionController(app.context), local = await app.persistence.localActivityDeletionAdmission(app.admission);
    const preview = await deletion.preview(app.owner, { scope: "all" }, local);
    await deletion.confirm(app.owner, { operationId: preview.operationId, confirmed: true }, local);
    const source = structuredClone(app.source);
    for (const row of source) row.capture.captureId += "-later";
    const ticket = await app.begin();
    await app.persistence.commit(ticket, source);
    assert.deepEqual(await app.persistence.compareCommittedSource(ticket, source),
        { schemaVersion: 1, status: "suppressed", sourceObservationInputs: source.length,
            retainedObservationInputs: 0, suppressedObservations: source.length });
    assert.equal((await app.retained()).records.length, 0);
});

test("uncommitted, missing, empty, different and retired source inputs are explicitly unverified", async t => {
    const app = await setup(t);
    const uncommitted = await app.begin();
    assert.equal((await app.persistence.compareCommittedSource(uncommitted, app.source)).reason, "operation-not-committed");
    app.persistence.retire(uncommitted);
    const missing = await app.begin();
    assert.equal((await app.persistence.compareCommittedSource(missing, undefined)).reason, "source-unavailable");
    app.persistence.retire(missing);
    const empty = await app.begin();
    await app.persistence.commit(empty, []);
    assert.equal((await app.persistence.compareCommittedSource(empty, [])).reason, "empty-source");
    app.persistence.retire(empty);
    const different = await app.begin();
    await app.persistence.commit(different, app.source);
    const altered = structuredClone(app.source); altered[0].capture.captureId += "-not-original";
    assert.equal((await app.persistence.compareCommittedSource(different, altered)).reason, "source-mismatch");
    app.persistence.retire(different);
    const retired = await app.begin();
    await app.persistence.commit(retired, app.source);
    app.persistence.retire(retired);
    assert.equal((await app.persistence.compareCommittedSource(retired, app.source)).reason, "ticket-unavailable");
});

test("signout during committed-document reading prevents a positive comparison without holding lifecycle", { timeout: 10000 }, async t => {
    const app = await setup(t), ticket = await app.begin();
    const receipt = await app.persistence.commit(ticket, app.source);
    const entered = Promise.withResolvers(), resume = Promise.withResolvers(), original = filesystem.open;
    const file = path.join(app.context.dataDir, "private-evidence", receipt.snapshot + ".json");
    const mock = t.mock.method(filesystem, "open", async (target, ...args) => {
        if (args[0] === "r" && path.resolve(String(target)) === file) { entered.resolve(); await resume.promise; }
        return original(target, ...args);
    });
    syncBuiltinESMExports();
    t.after(() => { resume.resolve(); mock.mock.restore(); syncBuiltinESMExports(); });
    const pending = app.persistence.compareCommittedSource(ticket, app.source);
    await entered.promise;
    await app.lifecycle.command(app.owner, { action: "wire-sign-out", operationId: randomUUID(),
        generation: (await app.lifecycle.status()).generation }, () => true);
    resume.resolve();
    assert.deepEqual(await pending, { schemaVersion: 1, status: "unverified", reason: "retained-access-unavailable" });
});

test("comparison uses fresh retained authority after Pause and expiry, not the historical acquisition generation", async t => {
    const app = await setup(t), ticket = await app.begin(), receipt = await app.persistence.commit(ticket, app.source);
    await app.lifecycle.expire(ticket.lease);
    await app.lifecycle.setNativeCollectionEnabled(false, (await app.lifecycle.status()).authorizationRevision, app.admission);
    assert.notEqual((await app.retained()).readback.current.generation, receipt.generation);
    assert.equal((await app.persistence.compareCommittedSource(ticket, app.source)).status, "matched");
});

test("comparison never adopts a later operation even when its current document has identical bytes", async t => {
    const app = await setup(t), first = await app.begin(), receipt = await app.persistence.commit(first, app.source);
    const later = await app.begin(), next = await app.persistence.commit(later, []);
    assert.equal(next.snapshot, receipt.snapshot);
    assert.deepEqual(await app.persistence.compareCommittedSource(first, app.source),
        { schemaVersion: 1, status: "unverified", reason: "snapshot-not-current" });
});

test("comparison cannot read the previous account after deliberate replacement", async t => {
    const app = await setup(t), ticket = await app.begin();
    await app.persistence.commit(ticket, app.source);
    assert.equal((await app.replaceAccount()).outcome, "completed");
    assert.deepEqual(await app.persistence.compareCommittedSource(ticket, app.source),
        { schemaVersion: 1, status: "unverified", reason: "account-changed" });
});

for (const change of ["configuration", "retirement"]) test(`comparison rejects ${change} during its asynchronous document read`, { timeout: 10000 }, async t => {
    const app = await setup(t), ticket = await app.begin(), receipt = await app.persistence.commit(ticket, app.source);
    const entered = Promise.withResolvers(), resume = Promise.withResolvers(), original = filesystem.open;
    const file = path.join(app.context.dataDir, "private-evidence", receipt.snapshot + ".json");
    const mock = t.mock.method(filesystem, "open", async (target, ...args) => {
        if (args[0] === "r" && path.resolve(String(target)) === file) { entered.resolve(); await resume.promise; }
        return original(target, ...args);
    });
    syncBuiltinESMExports();
    t.after(() => { resume.resolve(); mock.mock.restore(); syncBuiltinESMExports(); });
    const pending = app.persistence.compareCommittedSource(ticket, app.source);
    await entered.promise;
    if (change === "retirement") app.persistence.retire(ticket);
    else await app.persistence.configure({ expectedRevision: receipt.configurationRevision, surfaces: ["chat", "cowork"], windowDays: 7 }, app.admission);
    resume.resolve();
    assert.deepEqual(await pending, { schemaVersion: 1, status: "unverified",
        reason: change === "retirement" ? "ticket-unavailable" : "source-state-changed" });
});

test("comparison rejects a committed document that still contains tombstoned source", async t => {
    const app = await setup(t), ticket = await app.begin(), receipt = await app.persistence.commit(ticket, app.source);
    const document = JSON.parse(await readFile(path.join(app.context.dataDir, "private-evidence", receipt.snapshot + ".json"), "utf8"));
    await updateBoardState(app.context, state => {
        state.deletion = { schemaVersion: 1, epoch: 1,
            identities: [nativeObservationDeletionIdentity(document.observations[0].key)], events: [], contextCalls: [], operations: {} };
    });
    assert.deepEqual(await app.persistence.compareCommittedSource(ticket, app.source),
        { schemaVersion: 1, status: "unverified", reason: "tombstone-mismatch" });
});

test("comparison cannot bind an operation whose persisted owner differs from the actual ticket", async t => {
    const app = await setup(t), ticket = await app.begin(), receipt = await app.persistence.commit(ticket, app.source);
    await updateBoardState(app.context, state => {
        state.nativeRetention.receipts.find(item => item.operationId === receipt.operationId).ownerHash = "0".repeat(64);
    });

    assert.deepEqual(await app.persistence.compareCommittedSource(ticket, app.source),
        { schemaVersion: 1, status: "unverified", reason: "operation-mismatch" });
});

test("segmented comparison verifies exact source provenance after release and never replays its ticket", async t => {
    const app = await setup(t);
    const begun = await app.persistence.beginSegmented({ operationId: randomUUID() }, app.admission);
    await app.persistence.commitSegmented(begun.ticket, app.source);
    app.releaseRequester();
    const before = await app.bytes(), checks = app.requesterChecks;
    assert.deepEqual(await app.persistence.compareCommittedSource(begun.ticket, app.source), {
        schemaVersion: 1, status: "matched", sourceObservationInputs: app.source.length,
        retainedObservationInputs: app.source.length, suppressedObservations: 0,
    });
    assert.equal(app.requesterChecks, checks);
    assert.deepEqual(await app.bytes(), before);
    assert.equal((await app.persistence.compareCommittedSource(begun.ticket, app.source)).reason, "comparison-already-attempted");
});
