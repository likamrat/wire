import { createHmac } from "node:crypto";
import { isNativeMicrosoftSession } from "./microsoft-session.mjs";
import { BoardError, exclusiveBoard, resolveDataDir } from "./store.mjs";
import { validateNativeReportEntry } from "./native-retention-state.mjs";
import { nativeRetentionHash } from "./native-retention-contract.mjs";
import { artifactDeletionKey, deletionHash } from "./deletion-identities.mjs";
import { DELETION_LIMITS } from "./deletion-limits.mjs";
import { assertArtifactDeletionPlan, revalidateArtifactDeletionPlan } from "./deletion-storage.mjs";
export { validateNativeArtifactDeletionSeal } from "./native-retention-state.mjs";

const guards = new WeakMap(), turns = new WeakMap();
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const bundle = value => typeof value === "string" && /^export-[a-f0-9-]{36}$/.test(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const fail = (code = "NATIVE_ARTIFACT_MUTATION_UNAVAILABLE", status = 403) => {
    throw Object.assign(new BoardError("Saved artifact mutation is unavailable for this request or selection.", status), { code });
};
function sync(work) {
    const value = work();
    if (value && typeof value.then === "function") { Promise.resolve(value).catch(() => {}); fail(); }
    if (value !== undefined && value !== true) fail();
}
function freeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze); Object.freeze(value);
    }
    return value;
}
const native = row => Object.hasOwn(row, "nativeSourceBinding") || Object.hasOwn(row, "nativeEvidenceHash") || Object.hasOwn(row, "nativeComparisonHash");
const kind = row => row.kind ?? "report";
const accountRef = (state, partition) => partition ? createHmac("sha256", state.pseudonymKey)
    .update(JSON.stringify(["native-report-account-v1", partition])).digest("hex") : null;
const preservedState = state => {
    const { exports, artifactDeletion, deletion, revision, ...preserved } = state;
    return nativeRetentionHash(preserved);
};

export async function createNativeArtifactMutationAdmission(context, lifecycle, request, assertInstance, assertCustody) {
    if (!isNativeMicrosoftSession(lifecycle, context) || typeof assertInstance !== "function" || typeof assertCustody !== "function"
        || !request || typeof request.owner !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(request.owner)
        || typeof request.check !== "function" || typeof request.dispatched !== "function") fail();
    const owner = request.owner;
    const check = () => {
        sync(assertInstance);
        if (request.owner !== owner || !isNativeMicrosoftSession(lifecycle, context)) fail();
        sync(() => request.check());
    };
    check();
    const status = await lifecycle.status();
    check();
    const partition = status.microsoft.partition;
    const lease = await lifecycle.lease(partition ? "microsoft-retained" : "retained");
    check();
    if (lease.generation !== status.generation || partition && lease.partition !== partition) fail();
    const guard = Object.freeze({});
    guards.set(guard, { context, lifecycle, lease, partition, owner, check, assertCustody, request });
    return guard;
}

export function isNativeArtifactMutationAdmission(guard, context, owner) {
    const held = guards.get(guard);
    return Boolean(held && held.context === context && held.owner === owner);
}

function qualify(state, scope, membership, partition) {
    const bulk = exact(scope, ["scope"]) && scope.scope === "all-reports";
    if (!bulk && (!exact(scope, ["artifactKind", "artifactId"]) || !["report", "comparison"].includes(scope.artifactKind)
        || !bundle(scope.artifactId)) || !bulk && membership !== null) fail("NATIVE_ARTIFACT_MUTATION_SELECTION_INVALID", 422);
    if (membership !== null && (!Array.isArray(membership) || !membership.length || membership.length > 10000
        || membership.some(id => !bundle(id)) || new Set(membership).size !== membership.length)) fail("NATIVE_ARTIFACT_MUTATION_SELECTION_INVALID", 422);
    const ids = bulk ? membership ?? state.exports.filter(row => kind(row) === "report").map(row => row.bundleId) : [scope.artifactId];
    if (!ids.length || ids.length > 10000 || new Set(ids).size !== ids.length) fail("NATIVE_ARTIFACT_MUTATION_SELECTION_INVALID", 422);
    const currentAccount = accountRef(state, partition);
    function entry(id) {
        const rows = state.exports.filter(row => row.bundleId === id);
        if (rows.length !== 1) fail();
        const row = rows[0];
        if (native(row)) {
            validateNativeReportEntry(row);
            if (currentAccount === null || row.nativeSourceBinding.account !== currentAccount) fail();
        }
        return row;
    }
    const selected = ids.map(id => entry(id));
    if (selected.some(row => kind(row) !== (bulk ? "report" : scope.artifactKind)
        || state.artifactDeletion?.identities?.includes(artifactDeletionKey(kind(row), row.bundleId)))) fail();
    const dependencies = state.exports.filter(row => kind(row) === "comparison"
        && row.sourceReports?.some(source => ids.includes(source.bundleId))).map(row => entry(row.bundleId));
    const sources = new Map();
    for (const comparison of [...selected, ...dependencies].filter(row => kind(row) === "comparison")) {
        for (const source of comparison.sourceReports ?? []) {
            if (!bundle(source.bundleId) || !hash(source.snapshotHash)) fail();
            if (!state.exports.some(row => row.bundleId === source.bundleId)) continue;
            const row = entry(source.bundleId);
            if (kind(row) !== "report" || row.snapshotHash !== source.snapshotHash) fail();
            sources.set(row.bundleId, row);
        }
    }
    const fingerprint = nativeRetentionHash({ selected, dependencies, sources: [...sources.values()],
        account: currentAccount, pseudonymKey: state.pseudonymKey, artifactDeletion: state.artifactDeletion ?? null });
    return { ids, selected, dependencies, sources: [...sources.values()], fingerprint, account: currentAccount, bulk };
}

function owned(authorization, context, state) {
    const turn = turns.get(authorization);
    if (!turn || !turn.active || turn.context !== context || turn.state !== state) fail();
    turn.guard.check();
    return turn;
}
export function assertNativeArtifactMutation(authorization, context, state, artifactId) {
    const turn = owned(authorization, context, state);
    if (turn.phase !== "prepared" || !turn.allowed.has(artifactId)) fail();
    if (qualify(state, turn.scope, turn.membership, turn.guard.partition).fingerprint !== turn.selection.fingerprint) fail("NATIVE_ARTIFACT_MUTATION_STALE", 409);
}
export function nativeArtifactMutationBinding(authorization, context, state) {
    const turn = owned(authorization, context, state);
    for (const id of turn.selection.ids) assertNativeArtifactMutation(authorization, context, state, id);
    return turn.selection.fingerprint;
}

export async function withNativeArtifactMutation(guard, context, owner, input, work) {
    if (!isNativeArtifactMutationAdmission(guard, context, owner) || !exact(input, ["scope", "membership", "readOnly"])
        || typeof input.readOnly !== "boolean" || typeof work !== "function") fail();
    input = structuredClone(input);
    const held = guards.get(guard);
    held.check();
    const result = await held.lifecycle.admit(held.lease, async () => {
        try {
            return { value: await exclusiveBoard(context, async (state, save) => {
                held.check();
                if (state.deletion?.pending) fail("NATIVE_ARTIFACT_CLEANUP_PENDING", 503);
                const selection = qualify(state, input.scope, input.membership, held.partition), authorization = Object.freeze({});
                const turn = { active: true, context, state, save, guard: held, selection, scope: input.scope,
                    membership: selection.bulk ? [...selection.ids] : null, readOnly: input.readOnly, phase: "prepared",
                    allowed: new Set([...selection.selected, ...selection.dependencies, ...selection.sources].map(row => row.bundleId)),
                    preserved: preservedState(state), beforeExports: structuredClone(state.exports),
                    beforeDeletion: structuredClone(state.deletion), revision: state.revision };
                turns.set(authorization, turn);
                try {
                    const value = await work(state, authorization);
                    held.check();
                    if (!input.readOnly && turn.phase !== "complete") fail("NATIVE_ARTIFACT_MUTATION_INCOMPLETE", 409);
                    return value;
                } finally { turn.active = false; turns.delete(authorization); }
            }, { readOnly: input.readOnly }) };
        } catch (error) { return { error }; }
    });
    if (Object.hasOwn(result, "error")) throw result.error;
    return result.value;
}

export function bindNativeArtifactMutationPlan(authorization, context, state, target) {
    const turn = owned(authorization, context, state);
    nativeArtifactMutationBinding(authorization, context, state);
    assertArtifactDeletionPlan(target, resolveDataDir(context), state);
    if (!object(target) || !Array.isArray(target.descriptors) || target.descriptors.length !== turn.selection.ids.length
        || !Array.isArray(target.actions) || target.actions.length > DELETION_LIMITS.files
        || Buffer.byteLength(JSON.stringify(target)) > DELETION_LIMITS.metadataBytes) fail("NATIVE_ARTIFACT_MUTATION_PLAN_INVALID", 422);
    const selected = new Map(turn.selection.selected.map(row => [row.bundleId, row]));
    for (const descriptor of target.descriptors) {
        const entry = selected.get(descriptor.bundleId);
        if (!entry || descriptor.kind !== kind(entry) || descriptor.manifestHash !== null && !hash(descriptor.manifestHash)
            || !hash(descriptor.inventoryHash)
            || !["files", "bundle-root"].includes(descriptor.layout) || !Array.isArray(descriptor.files)
            || !descriptor.files.length || descriptor.files.length > 1000
            || descriptor.files.some(file => !exact(file, ["name", "sha256"]) || typeof file.name !== "string"
                || !/^[^\\/:*?"<>|\u0000-\u001f]{1,200}$/.test(file.name) || [".", ".."].includes(file.name) || !hash(file.sha256))
            || new Set(descriptor.files.map(file => file.name.toLowerCase())).size !== descriptor.files.length
            || descriptor.inventoryHash !== deletionHash(JSON.stringify({
                bundleId: descriptor.bundleId, kind: descriptor.kind, layout: descriptor.layout, files: descriptor.files,
            }))
            || native(entry) && (!hash(descriptor.manifestHash) || descriptor.manifestHash !== entry.manifestHash)) fail("NATIVE_ARTIFACT_MUTATION_PLAN_INVALID", 422);
        selected.delete(descriptor.bundleId);
        const expected = turn.selection.dependencies.filter(row => row.sourceReports?.some(source => source.bundleId === descriptor.bundleId))
            .map(row => row.bundleId).sort();
        if (!Array.isArray(descriptor.dependentComparisons)
            || nativeRetentionHash(descriptor.dependentComparisons.map(row => row.bundleId).sort()) !== nativeRetentionHash(expected)) fail();
    }
    const artifacts = turn.selection.selected.map(row => ({ artifactId: row.bundleId, artifactKind: kind(row) }));
    if (selected.size || target.indexHash !== deletionHash(JSON.stringify(target.descriptors.map(descriptor =>
        turn.selection.selected.find(row => row.bundleId === descriptor.bundleId))))
        || (target.scope === "all-reports") !== turn.selection.bulk
        || nativeRetentionHash(turn.selection.bulk ? target.artifacts : [target.artifact]) !== nativeRetentionHash(artifacts)) {
        fail("NATIVE_ARTIFACT_MUTATION_PLAN_INVALID", 422);
    }
    const identities = new Set(state.artifactDeletion?.identities ?? []);
    for (const entry of turn.selection.selected) identities.add(artifactDeletionKey(kind(entry), entry.bundleId));
    if (!exact(target.artifactDeletion, ["schemaVersion", "revision", "identities"]) || target.artifactDeletion.schemaVersion !== 1
        || target.artifactDeletion.revision !== (state.artifactDeletion?.revision ?? 0) + 1
        || !Array.isArray(target.artifactDeletion.identities) || new Set(target.artifactDeletion.identities).size !== identities.size
        || target.artifactDeletion.identities.some(value => !identities.has(value))) fail("NATIVE_ARTIFACT_MUTATION_PLAN_INVALID", 422);
    turn.plan = freeze(structuredClone(target));
    turn.originalPlan = target;
    return turn.plan;
}

export async function dispatchNativeArtifactMutation(authorization, context, state) {
    const turn = owned(authorization, context, state);
    if (turn.readOnly || !turn.plan || turn.dispatched) fail();
    nativeArtifactMutationBinding(authorization, context, state);
    await turn.guard.assertCustody(); turn.guard.check();
    nativeArtifactMutationBinding(authorization, context, state);
    sync(() => turn.guard.request.dispatched());
    turn.dispatched = true;
}

export async function sealNativeArtifactMutation(authorization, context, state, input) {
    const turn = owned(authorization, context, state);
    if (turn.readOnly || !turn.plan || !turn.dispatched || !exact(input, ["operationId", "receiptHash", "startedAt", "cleanup"])
        || !uuid(input.operationId) || !hash(input.receiptHash) || !Number.isFinite(Date.parse(input.startedAt))
        || Object.hasOwn(turn.beforeDeletion?.operations ?? {}, input.operationId)
        || !Array.isArray(input.cleanup) || input.cleanup.length !== turn.plan.actions.length) fail("NATIVE_ARTIFACT_MUTATION_PLAN_INVALID", 422);
    nativeArtifactMutationBinding(authorization, context, state);
    if (preservedState(state) !== turn.preserved || state.revision !== turn.revision
        || nativeRetentionHash(state.exports) !== nativeRetentionHash(turn.beforeExports)
        || nativeRetentionHash(state.deletion ?? null) !== nativeRetentionHash(turn.beforeDeletion ?? null)) fail("NATIVE_ARTIFACT_MUTATION_STALE", 409);
    for (const [index, file] of input.cleanup.entries()) {
        const action = turn.plan.actions[index];
        if (!exact(file, ["area", "relative", "hash", ...action.asset ? ["asset"] : [],
            ...action.text !== null ? ["staged", "afterHash", "destination"] : []])
            || file.area !== action.area || file.relative !== action.relative || file.hash !== action.hash
            || Boolean(file.asset) !== Boolean(action.asset)
            || action.text === null && Object.hasOwn(file, "staged")
            || action.text !== null && (!file.staged || file.destination !== action.destination
                || !new RegExp(`^deletion-staging[\\\\/]${input.operationId}[\\\\/]${index}\\.json$`).test(file.staged)
                || file.afterHash !== deletionHash(action.text))) fail("NATIVE_ARTIFACT_MUTATION_PLAN_INVALID", 422);
    }
    await turn.guard.assertCustody(); turn.guard.check();
    nativeArtifactMutationBinding(authorization, context, state);
    await revalidateArtifactDeletionPlan(turn.originalPlan, resolveDataDir(context), state, input.operationId);
    await turn.guard.assertCustody(); turn.guard.check();
    nativeArtifactMutationBinding(authorization, context, state);
    const target = turn.plan;
    const operation = { operationId: input.operationId, kind: "artifact-deletion", ownerHash: deletionHash(turn.guard.owner),
        receiptHash: input.receiptHash, phase: "pending", startedAt: input.startedAt, cleanup: structuredClone(input.cleanup),
        ...(turn.selection.bulk ? { scope: "all-reports", artifacts: target.artifacts } : { artifact: target.artifact }),
        artifactRevision: target.artifactDeletion.revision, counts: target.counts,
        nativeArtifactAdmission: { schemaVersion: 1, account: turn.selection.account, binding: turn.selection.fingerprint } };
    const removed = new Set(turn.selection.ids);
    state.exports = turn.beforeExports.filter(entry => !removed.has(entry.bundleId));
    state.artifactDeletion = structuredClone(target.artifactDeletion);
    state.deletion = { schemaVersion: 1, identities: [], events: [], contextCalls: [], ...turn.beforeDeletion,
        operations: { ...turn.beforeDeletion?.operations, [operation.operationId]: operation }, pending: operation.operationId };
    state.revision++;
    await turn.save(state, turn.guard.check);
    turn.phase = "sealed"; turn.operation = operation;
    turn.sealedState = nativeRetentionHash(state);
    return operation;
}

export async function completeNativeArtifactMutation(authorization, context, state) {
    const turn = owned(authorization, context, state);
    if (turn.phase !== "sealed" || state.deletion?.pending !== turn.operation.operationId
        || state.deletion.operations[turn.operation.operationId] !== turn.operation || preservedState(state) !== turn.preserved
        || nativeRetentionHash(state) !== turn.sealedState) fail();
    await turn.guard.assertCustody();
    turn.operation.phase = "complete"; turn.operation.completedAt = new Date().toISOString();
    delete turn.operation.cleanup; delete state.deletion.pending;
    await turn.save(state);
    turn.phase = "complete";
}
