import { realpath } from "node:fs/promises";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { BoardError, loadBoardState, exclusiveBoard, resolveDataDir, stagePrivateEvidence, committedNativeRetentionIndex,
    readPrivateEvidenceBytes, verifyBoardStatePublication } from "./store.mjs";
import { assertCollectorLockOwned } from "./collector-io.mjs";
import { isNativeMicrosoftSession, MicrosoftSessionError } from "./microsoft-session.mjs";
import { isMicrosoftNativeReadTransport } from "./microsoft-native-transport.mjs";
import { NATIVE_RETAINED_CONTRACT, NATIVE_READ_LIMITS, NATIVE_JSON_LIMITS, NativeReadModelError,
    nativeValueHasCredentials, annotateNativeRetentionDiagnostic, measureNativeJson } from "./native-read-model.mjs";
import { NATIVE_RETENTION_POLICY_ID, NATIVE_REPORT_STORAGE_POLICY_ID, validateNativeRetentionState,
    validateNativeCollectionSettings, validateNativeReportBinding, validateNativeReportEntry, validateNativeReportState } from "./native-retention-state.mjs";
import { validateNativeRetainedAccount, encodeNativeRetainedCapture, mergeNativeRetainedCapture,
    validateNativeRetainedDocument, filterNativeRetainedDocument, filterNativeRetainedCapture, nativeRetentionHash } from "./native-retention-contract.mjs";
import { projectRetainedNativeRecords, projectRetainedNativeEntries } from "./retained-population.mjs";
import { activityDeletionVersion, artifactDeletionKey, nativeObservationDeletionAliases } from "./deletion-identities.mjs";
import { assertArtifactWritable, savedArtifact, assertSavedReportDependencies } from "./report-artifacts.mjs";
import { stageNativeV1Capture } from "./native-segmented-v1.mjs";
import { NATIVE_SEGMENTED_CONTRACT, NativeSegmentedError, nativeObservationReference, nativeCaptureReference } from "./native-segmented-codec.mjs";
import { stageNativeSegmentedCapture } from "./native-segmented-merge.mjs";
import { openNativeSegmentedReader } from "./native-segmented-read.mjs";
import { openNativeLegacyReader } from "./native-legacy-read.mjs";
import { nativeReportSelectionExpectations } from "./native-report-selection.mjs";
import { normalizeNativeSelectionQuery } from "./native-selected-read.mjs";
import { createLocalActivityDeletionAdmission } from "./local-activity-deletion-admission.mjs";
import { createNativeArtifactMutationAdmission } from "./native-artifact-mutation.mjs";
import { pinNativeReportPublication, assertNativeReportPublicationIndex, verifyNativeReportPublicationFiles } from "./native-report-publication.mjs";
import { compactNativeReceipts, nativeReceiptCapacityAvailable, nativeReceiptsNeedArchival, readArchivedNativeReceipt } from "./native-receipt-archive.mjs";
import { validNativeFailure } from "./microsoft-session-state.mjs";
import { createNativeBackfill, nativeBackfillFor, nativeBackfillSummary, validateNativeBackfill } from "./native-backfill-state.mjs";

const instances = new WeakMap();
const reportSources = new WeakMap();
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const fail = (code, status = 409) => { throw Object.assign(new BoardError(`Native retention: ${code}.`, status), { code }); };
const copy = value => structuredClone(value);
const nativeSurfaces = Object.freeze(["chat", "cowork"]);
const nativeDefaultWindowDays = 30;
function validateAt(stage, work) {
    try { return work(); }
    catch (error) { throw annotateNativeRetentionDiagnostic(error, stage); }
}
const publicReceipt = (receipt, pending = false) => {
    const { fingerprint, ownerHash, intentFingerprint, storageIntent, schemaVersion, firstFailure, backfill, ...result } = receipt;
    return { schemaVersion: 1, ...copy(result), ...(receipt.status === "registered" ? { status: pending ? "pending" : "unknown" } : {}) };
};
const configuration = value => value ? {
    configurationRevision: value.configurationRevision, privacyRevision: value.privacyRevision,
    policy: value.policy, settings: copy(value.settings), surfaces: [...value.surfaces],
} : null;

export function isNativePersistence(value, context, lifecycle) {
    const owner = instances.get(value);
    return Boolean(owner && !owner.closed && owner.context === context && owner.lifecycle === lifecycle);
}

export function isNativeReportSource(value, context) {
    const owner = reportSources.get(value);
    return Boolean(owner && !owner.closed && owner.context === context);
}

export function assertNativeReportRuntime(state, source, context) {
    validateNativeReportState(state);
    if ((state.stateVersion === 5 || state.nativeReportPolicy !== undefined) && !isNativeReportSource(source, context)) {
        fail("NATIVE_REPORT_RUNTIME_REQUIRED", 503);
    }
}

export async function readNativeCollectionSettings(context) {
    return exclusiveBoard(context, state => {
        if (!state.nativeRetention) return null;
        validateNativeRetentionState(state.nativeRetention);
        return { ...copy(state.nativeRetention.settings), configurationRevision: state.nativeRetention.configurationRevision,
            privacyRevision: state.nativeRetention.privacyRevision };
    }, { readOnly: true });
}

export async function readGlobalCollectionGate(context) {
    return exclusiveBoard(context, state => Object.hasOwn(state, "globalCollection")
        ? Object.freeze({ revision: state.globalCollection.revision, paused: state.globalCollection.paused }) : null, { readOnly: true });
}

export async function createNativePersistence(context, { lifecycle, transport, preAccount, configurationIntents = false, backfillTracking = false } = {}) {
    if (!context?.dataDir || !isNativeMicrosoftSession(lifecycle, context) || !isMicrosoftNativeReadTransport(transport)
        || preAccount !== undefined && preAccount !== "metadata-only" || typeof configurationIntents !== "boolean" || typeof backfillTracking !== "boolean"
        || configurationIntents && (typeof lifecycle.nativeConfigurationStatus !== "function"
            || typeof lifecycle.assertNativeConfigurationAdmission !== "function")) {
        fail("NATIVE_RETENTION_BINDING_REQUIRED", 403);
    }
    const sourceAware = typeof lifecycle.assertGlobalCollectionAdmission === "function";
    if (sourceAware && (typeof lifecycle.globalCollectionStatus !== "function" || typeof lifecycle.admitGlobalCollection !== "function")) {
        fail("NATIVE_RETENTION_BINDING_REQUIRED", 403);
    }
    const directory = await realpath(resolveDataDir(context));
    await exclusiveBoard(context, () => {}, { readOnly: true });
    const owner = { context, lifecycle, directory, closed: false }, tickets = new WeakMap(), activeOperations = new Map();
    const issuedOperations = new Set();
    const sourceComparisons = new WeakMap();
    const reportFrames = new WeakMap();
    const readerBindings = new WeakMap(), retainedReaderFrames = new WeakMap();
    const savedComparisonFrames = new WeakMap();
    let authorization;
    const unsubscribe = preAccount === "metadata-only" || configurationIntents
        ? lifecycle.subscribeAuthorizationChange(event => { authorization = event; }) : null;
    function current() {
        if (owner.closed || !isNativeMicrosoftSession(lifecycle, context)
            || path.resolve(resolveDataDir(context)) !== path.resolve(directory)) fail("NATIVE_RETENTION_CLOSED", 403);
    }
    function admission(value) {
        if (!value || typeof value.check !== "function" || typeof value.dispatched !== "function") fail("NATIVE_RETENTION_REQUEST_REQUIRED", 403);
        return value;
    }
    function operationOwner(value) {
        if (typeof value?.owner !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(value.owner)) {
            fail("NATIVE_RETENTION_OPERATION_OWNER_REQUIRED", 403);
        }
        return nativeRetentionHash(["native-operation-owner-v1", value.owner]);
    }
    function checkRequest(value) {
        current();
        const checked = value.check();
        if (checked && typeof checked.then === "function") {
            Promise.resolve(checked).catch(() => {});
            fail("NATIVE_RETENTION_REQUEST_REVOKED", 403);
        }
        if (checked !== undefined && checked !== true) fail("NATIVE_RETENTION_REQUEST_REVOKED", 403);
    }
    function dispatched(value) {
        const result = value.dispatched();
        if (result && typeof result.then === "function") {
            Promise.resolve(result).catch(() => {});
            fail("NATIVE_RETENTION_REQUEST_INVALID", 403);
        }
    }
    function accountFor(lease) {
        if (lease?.kind !== "microsoft-read") fail("NATIVE_RETENTION_ACQUISITION_REQUIRED", 403);
        const value = transport.accountFor(lease);
        if (value.partition !== lease.partition || value.account?.verification !== "verified") fail("NATIVE_RETENTION_ACCOUNT_UNQUALIFIED", 403);
        return validateNativeRetainedAccount({ partition: value.partition, issuer: value.issuer,
            tenantId: value.account.tenantId, subjectId: value.account.subjectId });
    }
    async function admit(lease, work) {
        const result = await lifecycle.admit(lease, async () => {
            try { return { value: await work() }; }
            catch (error) { return { error }; }
        });
        if (Object.hasOwn(result, "error")) throw result.error;
        return result.value;
    }
    async function lock() {
        current();
        if (await realpath(resolveDataDir(context)) !== directory) fail("NATIVE_RETENTION_DIRECTORY_CHANGED", 403);
        await assertCollectorLockOwned(directory);
    }
    function availableState(state) {
        if (state.deletion?.pending && state.deletion.operations?.[state.deletion.pending]?.kind !== "artifact-deletion") {
            fail("NATIVE_RETENTION_DELETION_PENDING", 503);
        }
        if (state.nativeRetention) validateNativeRetentionState(state.nativeRetention);
    }
    function initial(settings) {
        return { schemaVersion: 1, policy: NATIVE_RETENTION_POLICY_ID, configurationRevision: 1, privacyRevision: 1,
            settings: copy(settings), surfaces: [...nativeSurfaces], accounts: [], partitions: [], receipts: [] };
    }
    function grant(state, account) {
        availableState(state);
        const value = state.nativeRetention;
        const saved = value?.accounts.find(item => item.partition === account.partition);
        if (!saved || nativeRetentionHash(saved) !== nativeRetentionHash(account)) fail("NATIVE_RETENTION_NOT_CONFIGURED", 428);
        return value;
    }
    async function documentBytes(file) {
        if (typeof file !== "string" || !/^[a-f0-9]{64}\.json$/.test(file)) fail("NATIVE_RETENTION_POINTER_INVALID", 500);
        try { return await readPrivateEvidenceBytes(context, file, { maxBytes: NATIVE_READ_LIMITS.bytes }); }
        catch (error) {
            if (error.code === "EVIDENCE_SNAPSHOT_INTEGRITY") fail("NATIVE_RETENTION_INTEGRITY", 500);
            throw error;
        }
    }
    async function readDocument(file, stage) {
        const bytes = await documentBytes(file);
        let document;
        try { document = JSON.parse(bytes.toString("utf8")); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; fail("NATIVE_RETENTION_DOCUMENT_INVALID", 500); }
        if (document.contractVersion === NATIVE_SEGMENTED_CONTRACT) fail("NATIVE_SEGMENTED_READER_REQUIRED", 503);
        validateAt(stage, () => validateNativeRetainedDocument(document));
        return document;
    }
    async function receiptFor(operationId, request) {
        const ownerHash = operationOwner(request);
        const lease = await lifecycle.lease("microsoft-retained");
        const state = await loadBoardState(context, { readOnly: true });
        current();
        await lifecycle.assertLease(lease);
        const receipt = state.nativeRetention?.receipts.find(item => item.operationId === operationId)
            ?? await readArchivedNativeReceipt(context, state.nativeRetention, operationId);
        await lifecycle.assertLease(lease);
        current();
        if (receipt && (receipt.partition !== lease.partition || receipt.ownerHash !== ownerHash
            || receipt.intent !== "native-collect-now")) fail("NATIVE_RETENTION_OPERATION_OWNER", 403);
        return receipt ?? null;
    }
    function checkFence(state, ticket) {
        checkRequest(ticket.admission);
        if (ticket.retired) fail("NATIVE_RETENTION_TICKET_RETIRED", 403);
        if (ticket.failureRecorded && !state.nativeRetention?.receipts.some(receipt =>
            receipt.operationId === ticket.operationId && receipt.status === "committed")) fail("NATIVE_RETENTION_TICKET_FAILED", 403);
        const account = accountFor(ticket.lease), saved = grant(state, account);
        if (state.globalCollection?.paused) fail("NATIVE_RETENTION_GLOBAL_PAUSED", 403);
        if ((state.globalCollection?.revision ?? null) !== ticket.globalRevision) fail("NATIVE_RETENTION_GLOBAL_CHANGED");
        if (saved.settings.paused || saved.configurationRevision !== ticket.configurationRevision
            || saved.privacyRevision !== ticket.privacyRevision || saved.policy !== NATIVE_RETENTION_POLICY_ID) {
            fail("NATIVE_RETENTION_CONFIGURATION_CHANGED");
        }
        if (nativeRetentionHash(account) !== nativeRetentionHash(ticket.account)) fail("NATIVE_RETENTION_ACCOUNT_CHANGED", 403);
        if (ticket.storageIntent && !saved.receipts.some(item => item.operationId === ticket.operationId
            && item.ownerHash === ticket.ownerHash && item.partition === account.partition && item.status === "committed")) {
            const pointer = saved.partitions.find(item => item.partition === account.partition);
            if ((pointer?.file.slice(0, -5) ?? null) !== ticket.storageIntent.previousSnapshot
                || (pointer ? pointer.format ?? "screened-v1" : null) !== ticket.storageIntent.previousFormat) {
                fail("NATIVE_RETENTION_PREDECESSOR_CHANGED");
            }
        }
        return saved;
    }
    async function configure(input, request) {
        current(); request = admission(request); checkRequest(request);
        if (configurationIntents) fail("NATIVE_RETENTION_CONFIGURATION_INTENT_REQUIRED", 403);
        operationOwner(request);
        if (!exact(input, ["expectedRevision", "surfaces", "windowDays"])
            || input.expectedRevision !== null && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
            || !Array.isArray(input.surfaces) || !input.surfaces.length || new Set(input.surfaces).size !== input.surfaces.length
            || input.surfaces.some(surface => !nativeSurfaces.includes(surface))
            || !Number.isSafeInteger(input.windowDays) || input.windowDays < 1 || input.windowDays > 90) fail("NATIVE_RETENTION_CONFIGURATION_INVALID", 422);
        const intent = await lifecycle.collectionIntent();
        if (!intent || intent.lease?.kind !== "microsoft-read") fail("NATIVE_RETENTION_ACQUISITION_REQUIRED", 403);
        const lease = intent.lease, account = accountFor(lease);
        const status = await lifecycle.status();
        await lock();
        return admit(lease, () => exclusiveBoard(context, async (state, save) => {
            checkRequest(request); availableState(state); await lock();
            accountFor(lease);
            if ((state.nativeRetention?.configurationRevision ?? null) !== input.expectedRevision) fail("NATIVE_RETENTION_CONFIGURATION_CHANGED");
            const previous = state.nativeRetention;
            const settings = { paused: previous?.settings.paused ?? status.collection === "paused", windowDays: input.windowDays };
            const value = previous ? copy(previous) : initial(settings);
            const saved = value.accounts.find(item => item.partition === account.partition);
            if (saved && nativeRetentionHash(saved) !== nativeRetentionHash(account)) fail("NATIVE_RETENTION_ACCOUNT_CHANGED", 403);
            const surfaces = [...input.surfaces].sort();
            const privacyChanged = !saved || JSON.stringify(value.surfaces) !== JSON.stringify(surfaces);
            const changed = !previous || privacyChanged || JSON.stringify(value.settings) !== JSON.stringify(settings);
            if (!changed) return configuration(value);
            if (!saved) value.accounts.push(copy(account));
            if (previous) {
                value.configurationRevision++;
                if (privacyChanged) value.privacyRevision++;
            }
            value.settings = settings; value.surfaces = surfaces;
            validateNativeRetentionState(value);
            if (nativeValueHasCredentials(value)) fail("NATIVE_RETENTION_PRIVACY_FAILED", 422);
            await lock(); checkRequest(request); dispatched(request);
            state.nativeRetention = value; state.stateVersion = 4; state.revision++;
            await save(state);
            return configuration(value);
        }));
    }
    async function configurationOffer(request) {
        current(); request = admission(request); checkRequest(request); operationOwner(request);
        const lease = await lifecycle.lease("retained");
        const capability = await lifecycle.nativeConfigurationStatus();
        if (!exact(capability, ["generation", "authorizationRevision", "partition", "enable", "save", ...sourceAware ? ["globalRevision"] : []])
            || !Number.isSafeInteger(capability.generation) || capability.generation < 0
            || !Number.isSafeInteger(capability.authorizationRevision) || capability.authorizationRevision < 0
            || capability.partition !== null && (typeof capability.partition !== "string" || !/^[a-f0-9]{64}$/.test(capability.partition))
            || typeof capability.enable !== "boolean" || typeof capability.save !== "boolean"
            || sourceAware && capability.globalRevision !== null && (!Number.isSafeInteger(capability.globalRevision) || capability.globalRevision < 1)) {
            fail("NATIVE_RETENTION_CONFIGURATION_AUTHORITY_INVALID", 403);
        }
        return admit(lease, () => exclusiveBoard(context, state => {
            checkRequest(request); availableState(state);
            if (capability.generation !== lease.generation || capability.generation !== authorization?.generation
                || capability.authorizationRevision !== authorization.revision) fail("NATIVE_RETENTION_CONFIGURATION_CHANGED");
            if (sourceAware && capability.globalRevision !== (state.globalCollection?.revision ?? null)) fail("NATIVE_RETENTION_GLOBAL_CHANGED");
            const value = state.nativeRetention;
            const configured = Boolean(capability.partition && value?.accounts.some(account => account.partition === capability.partition));
            const intent = configured ? "save" : "enable";
            const blocker = !capability.partition ? "NATIVE_CONFIGURATION_ACCOUNT_REQUIRED"
                : intent === "enable" && !capability.enable ? "NATIVE_CONFIGURATION_IDENTITY_REQUIRED"
                    : intent === "save" && !capability.save ? "NATIVE_CONFIGURATION_ACCESS_UNAVAILABLE" : null;
            return Object.freeze({ schemaVersion: sourceAware ? 2 : 1, kind: "native-configuration-offer",
                generation: capability.generation, authorizationRevision: capability.authorizationRevision,
                ...(sourceAware ? { globalRevision: capability.globalRevision } : {}),
                intent, available: blocker === null, expectedRevision: value?.configurationRevision ?? null,
                supportedSurfaces: nativeSurfaces,
                values: Object.freeze({ surfaces: Object.freeze([...(value?.surfaces ?? nativeSurfaces)]),
                    windowDays: value?.settings.windowDays ?? nativeDefaultWindowDays }),
                basis: value ? "committed-native" : "native-defaults", blockers: Object.freeze(blocker ? [blocker] : []) });
        }, { readOnly: true }));
    }
    async function configureIntent(input, token, request) {
        current(); request = admission(request); checkRequest(request); operationOwner(request);
        if (!exact(input, ["schemaVersion", "intent", "generation", "authorizationRevision", "expectedRevision", "surfaces", "windowDays",
            ...sourceAware ? ["globalRevision"] : []])
            || input.schemaVersion !== (sourceAware ? 2 : 1) || !["enable", "save"].includes(input.intent)
            || !Number.isSafeInteger(input.generation) || input.generation < 0
            || !Number.isSafeInteger(input.authorizationRevision) || input.authorizationRevision < 0
            || input.expectedRevision !== null && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
            || sourceAware && input.globalRevision !== null && (!Number.isSafeInteger(input.globalRevision) || input.globalRevision < 1)
            || !Array.isArray(input.surfaces) || !input.surfaces.length || new Set(input.surfaces).size !== input.surfaces.length
            || input.surfaces.some(surface => !nativeSurfaces.includes(surface))
            || !Number.isSafeInteger(input.windowDays) || input.windowDays < 1 || input.windowDays > 90) {
            fail("NATIVE_RETENTION_CONFIGURATION_INVALID", 422);
        }
        input = copy(input);
        const assertCurrent = () => {
            checkRequest(request);
            const value = lifecycle.assertNativeConfigurationAdmission(token);
            if (value.owner !== request.owner) fail("NATIVE_RETENTION_CONFIGURATION_OWNER", 403);
            if (value.generation !== input.generation || value.authorizationRevision !== input.authorizationRevision
                || value.intent !== input.intent || value.settings.windowDays !== input.windowDays
                || sourceAware && value.globalRevision !== input.globalRevision) fail("NATIVE_RETENTION_CONFIGURATION_CHANGED");
            validateNativeCollectionSettings(value.settings);
            return value;
        };
        assertCurrent(); await lock();
        return exclusiveBoard(context, async (state, save) => {
            assertCurrent(); availableState(state); await lock();
            const stamp = assertCurrent(), previous = state.nativeRetention;
            if (sourceAware && (state.globalCollection?.revision ?? null) !== input.globalRevision) fail("NATIVE_RETENTION_GLOBAL_CHANGED");
            if ((previous?.configurationRevision ?? null) !== input.expectedRevision) fail("NATIVE_RETENTION_CONFIGURATION_CHANGED");
            const saved = previous?.accounts.find(account => account.partition === stamp.partition);
            if (input.intent === "enable" ? Boolean(saved) || !stamp.account || stamp.settings.paused
                : !saved || stamp.settings.paused !== previous.settings.paused) fail("NATIVE_RETENTION_CONFIGURATION_CHANGED");
            const account = validateNativeRetainedAccount(stamp.account ?? saved);
            if (account.partition !== stamp.partition
                || saved && nativeRetentionHash(saved) !== nativeRetentionHash(account)) fail("NATIVE_RETENTION_ACCOUNT_CHANGED", 403);
            const settings = copy(stamp.settings), surfaces = [...input.surfaces].sort();
            const value = previous ? copy(previous) : initial(settings);
            const privacyChanged = !saved || JSON.stringify(value.surfaces) !== JSON.stringify(surfaces);
            const changed = !previous || privacyChanged || JSON.stringify(value.settings) !== JSON.stringify(settings);
            if (!changed) return configuration(value);
            if (!saved) value.accounts.push(copy(account));
            if (previous) {
                value.configurationRevision++;
                if (privacyChanged) value.privacyRevision++;
            }
            value.settings = settings; value.surfaces = surfaces;
            validateNativeRetentionState(value);
            if (nativeValueHasCredentials(value)) fail("NATIVE_RETENTION_PRIVACY_FAILED", 422);
            await lock(); assertCurrent(); dispatched(request);
            state.nativeRetention = value; state.stateVersion = 4; state.revision++;
            await save(state, () => {
                assertCurrent();
                if (sourceAware && (state.globalCollection?.revision ?? null) !== input.globalRevision) fail("NATIVE_RETENTION_GLOBAL_CHANGED");
            });
            return configuration(value);
        });
    }
    async function setGlobalCollectionGate(input, token, request) {
        current(); request = admission(request); checkRequest(request);
        const ownerHash = operationOwner(request);
        if (!sourceAware) fail("NATIVE_RETENTION_GLOBAL_ADMISSION_REQUIRED", 403);
        if (!exact(input, ["expectedRevision", "paused"]) || typeof input.paused !== "boolean"
            || input.expectedRevision !== null && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) {
            fail("NATIVE_RETENTION_GLOBAL_INVALID", 422);
        }
        input = copy(input);
        const assertCurrent = () => {
            checkRequest(request);
            const stamp = lifecycle.assertGlobalCollectionAdmission(token);
            if (!exact(stamp, ["owner", "generation", "authorizationRevision", "intent", "expectedRevision", "paused"])
                || stamp.intent !== "set-global-collection" || stamp.expectedRevision !== input.expectedRevision || stamp.paused !== input.paused
                || !Number.isSafeInteger(stamp.generation) || stamp.generation < 0
                || !Number.isSafeInteger(stamp.authorizationRevision) || stamp.authorizationRevision < 0
                || operationOwner(stamp) !== ownerHash || operationOwner(request) !== ownerHash) fail("NATIVE_RETENTION_GLOBAL_ADMISSION_REQUIRED", 403);
        };
        assertCurrent(); await lock();
        return exclusiveBoard(context, async (state, _save, saveGlobalCollection) => {
            assertCurrent(); availableState(state); await lock(); assertCurrent();
            const previous = state.globalCollection;
            if ((previous?.revision ?? null) !== input.expectedRevision) fail("NATIVE_RETENTION_GLOBAL_CHANGED");
            if (previous?.paused === input.paused) return Object.freeze({ revision: previous.revision, paused: previous.paused });
            await lock(); assertCurrent(); dispatched(request);
            return saveGlobalCollection(input, assertCurrent);
        });
    }
    const begin = (input, request) => beginWithFormat(input, request, false);
    const beginSegmented = (input, request) => beginWithFormat(input, request, true);
    async function beginWithFormat(input, request, segmented) {
        current(); request = admission(request); checkRequest(request);
        const hasBasis = object(input) && Object.hasOwn(input, "expectedBasis");
        if (!exact(input, ["operationId", ...(hasBasis ? ["expectedBasis"] : [])]) || !uuid(input.operationId)) {
            fail("NATIVE_RETENTION_OPERATION_INVALID", 422);
        }
        const expected = hasBasis ? copy(input.expectedBasis) : null;
        if (hasBasis && (!exact(expected, ["generation", "accountRef", "configurationRevision", "privacyRevision", "globalRevision"])
            || !Number.isSafeInteger(expected.generation) || expected.generation < 0
            || typeof expected.accountRef !== "string" || !/^[a-f0-9]{64}$/.test(expected.accountRef)
            || ["configurationRevision", "privacyRevision"].some(key => !Number.isSafeInteger(expected[key]) || expected[key] < 1)
            || expected.globalRevision !== null && (!Number.isSafeInteger(expected.globalRevision) || expected.globalRevision < 1))) {
            fail("NATIVE_RETENTION_EXPECTED_BASIS_INVALID", 422);
        }
        const ownerHash = operationOwner(request);
        const prior = await receiptFor(input.operationId, request);
        checkRequest(request);
        if (prior) {
            if ((prior.schemaVersion === 2) !== segmented) fail("NATIVE_RETENTION_OPERATION_CONFLICT");
            return { kind: prior.status === "committed" ? "committed" : "unresolved",
                receipt: publicReceipt(prior, activeOperations.has(input.operationId)) };
        }
        const lease = await lifecycle.lease("microsoft-read"), account = accountFor(lease);
        const state = await loadBoardState(context, { readOnly: true });
        const saved = grant(state, account);
        if (saved.settings.paused) fail("NATIVE_RETENTION_PAUSED", 403);
        await lifecycle.assertLease(lease); await lock(); checkRequest(request);
        const held = { operationId: input.operationId, lease, account, admission: request,
            ownerHash, configurationRevision: saved.configurationRevision, privacyRevision: saved.privacyRevision,
            globalRevision: state.globalCollection?.revision ?? null, consumed: false, retired: false };
        const pointer = saved.partitions.find(item => item.partition === account.partition);
        if (segmented) {
            const previousFormat = pointer ? pointer.format ?? "screened-v1" : null;
            held.storageIntent = { schemaVersion: 1, kind: previousFormat === "screened-v1" ? "new-capture-with-v1-adoption" : "new-capture",
                previousSnapshot: pointer?.file.slice(0, -5) ?? null, previousFormat, targetFormat: "segments-v2" };
        } else if (pointer?.format === "segments-v2") fail("NATIVE_SEGMENTED_MERGE_REQUIRED", 503);
        held.intentFingerprint = nativeRetentionHash({ intent: "native-collect-now", accountRef: account.partition,
            configurationRevision: saved.configurationRevision, privacyRevision: saved.privacyRevision,
            settings: saved.settings, surfaces: saved.surfaces,
            ...(held.globalRevision !== null ? { globalRevision: held.globalRevision } : {}),
            ...(held.storageIntent ? { storageIntent: held.storageIntent } : {}) });
        return admit(lease, () => exclusiveBoard(context, async (latest, save) => {
            const authorized = checkFence(latest, held);
            await lock();
            const existing = authorized.receipts.find(item => item.operationId === input.operationId);
            if (existing) {
                if (existing.partition !== account.partition || existing.ownerHash !== ownerHash) fail("NATIVE_RETENTION_OPERATION_OWNER", 403);
                if ((existing.schemaVersion === 2) !== segmented) fail("NATIVE_RETENTION_OPERATION_CONFLICT");
                return { kind: existing.status === "committed" ? "committed" : "unresolved",
                    receipt: publicReceipt(existing, activeOperations.has(input.operationId)) };
            }
            if (expected && (expected.generation !== lease.generation || expected.accountRef !== account.partition
                || expected.configurationRevision !== authorized.configurationRevision
                || expected.privacyRevision !== authorized.privacyRevision
                || expected.globalRevision !== (latest.globalCollection?.revision ?? null))) {
                fail("NATIVE_RETENTION_EXPECTED_BASIS_CHANGED");
            }
            if (!nativeReceiptCapacityAvailable(authorized, issuedOperations)) fail("NATIVE_RETENTION_RECEIPT_LIMIT", 503);
            held.deletionVersion = activityDeletionVersion(latest);
            const registered = { schemaVersion: segmented ? 2 : 1, operationId: input.operationId, partition: account.partition,
                ownerHash, intent: "native-collect-now", intentFingerprint: held.intentFingerprint, status: "registered",
                configurationRevision: authorized.configurationRevision, privacyRevision: authorized.privacyRevision,
                generation: lease.generation, registeredAt: new Date().toISOString(),
                ...(held.storageIntent ? { storageIntent: copy(held.storageIntent) } : {}) };
            let next = copy(authorized), dispatchStarted = false;
            if (nativeReceiptsNeedArchival(next, issuedOperations)) {
                dispatched(request); dispatchStarted = true;
                next = await compactNativeReceipts(context, next, issuedOperations, () => checkRequest(request), async archive => {
                    latest.nativeRetention = { ...copy(authorized), receiptArchive: archive };
                    latest.revision++;
                    await save(latest, () => { checkFence({ ...latest, nativeRetention: authorized }, held); });
                });
            }
            if (segmented) {
                next.schemaVersion = 2;
                next.partitions = next.partitions.map(item => ({ ...item, format: item.format ?? "screened-v1" }));
            }
            if (backfillTracking) {
                const progress = createNativeBackfill(account.partition, authorized.settings.windowDays, authorized.surfaces,
                    authorized.privacyRevision, next.backfill?.find(row => row.accountRef === account.partition),
                    Date.parse(registered.registeredAt), held.deletionVersion);
                held.backfillWindow = { ...progress.window };
                next.backfill = [...(next.backfill ?? []).filter(row => row.accountRef !== account.partition), progress];
                registered.backfill = nativeBackfillSummary(progress);
            }
            next.receipts.push(registered);
            validateNativeRetentionState(next);
            if (nativeValueHasCredentials(next)) fail("NATIVE_RETENTION_PRIVACY_FAILED", 422);
            await lock(); checkRequest(request);
            if (!dispatchStarted) dispatched(request);
            latest.nativeRetention = next; latest.stateVersion = 4; latest.revision++;
            await save(latest, () => { checkFence({ ...latest, nativeRetention: authorized }, held); });
            const selected = configuration(next);
            Object.freeze(selected.settings); Object.freeze(selected.surfaces);
            const ticket = Object.freeze({ operationId: input.operationId, lease, configuration: Object.freeze(selected),
                backfill: copy(next.backfill?.find(value => value.accountRef === account.partition
                    && (value.deletionVersion ?? 0) === held.deletionVersion) ?? null) });
            tickets.set(ticket, held); activeOperations.set(input.operationId, ticket); issuedOperations.add(input.operationId);
            return { kind: "acquire", ticket };
        }));
    }
    const commit = (ticket, envelopes) => commitWithFormat(ticket, envelopes, false);
    const commitSegmented = (ticket, envelopes) => commitWithFormat(ticket, envelopes, true);
    function applyBackfill(state, held, ticket, progress) {
        validateNativeBackfill(progress);
        if (progress.accountRef !== held.account.partition || progress.privacyRevision !== held.privacyRevision
            || activityDeletionVersion(state) !== held.deletionVersion || (progress.deletionVersion ?? 0) !== held.deletionVersion
            || progress.windowDays !== ticket.configuration.settings.windowDays
            || held.backfillWindow && (progress.window.from !== held.backfillWindow.from || progress.window.to !== held.backfillWindow.to)
            || JSON.stringify(progress.sources.map(row => row.surface).sort()) !== JSON.stringify([...ticket.configuration.surfaces].sort())) {
            fail("NATIVE_BACKFILL_SCOPE_CHANGED");
        }
        const receipt = state.nativeRetention.receipts.find(row => row.operationId === held.operationId);
        const summary = nativeBackfillSummary(progress);
        const compatible = state.nativeRetention.privacyRevision === held.privacyRevision
            && state.nativeRetention.settings.windowDays === progress.windowDays
            && JSON.stringify([...state.nativeRetention.surfaces].sort()) === JSON.stringify(progress.sources.map(row => row.surface).sort());
        const previous = state.nativeRetention.backfill?.find(row => row.accountRef === held.account.partition);
        if (JSON.stringify(receipt.backfill) === JSON.stringify(summary)
            && (!compatible || JSON.stringify(previous) === JSON.stringify(progress))) return false;
        receipt.backfill = summary;
        if (compatible) {
            state.nativeRetention.backfill = [...(state.nativeRetention.backfill ?? []).filter(row => row.accountRef !== held.account.partition), progress];
        }
        return true;
    }
    async function recordFailure(ticket, detail, sourceProgress) {
        current();
        const held = tickets.get(ticket);
        if (!held) fail("NATIVE_RETENTION_TICKET_INVALID", 403);
        if (held.retired) fail("NATIVE_RETENTION_TICKET_RETIRED", 403);
        const evidence = { ...copy(detail), recordedAt: new Date().toISOString() };
        if (!exact(detail, ["code", "predicate", ...(Object.hasOwn(detail ?? {}, "admission") ? ["admission"] : []),
            ...(Object.hasOwn(detail ?? {}, "publicCoworkScript") ? ["publicCoworkScript"] : []),
            ...(Object.hasOwn(detail ?? {}, "protocolStop") ? ["protocolStop"] : [])])
            || !validNativeFailure(evidence)) {
            fail("NATIVE_RETENTION_FAILURE_INVALID", 422);
        }
        await lock();
        return exclusiveBoard(context, async (state, save) => {
            const check = () => {
                current();
                if (held.retired) fail("NATIVE_RETENTION_TICKET_RETIRED", 403);
                const receipt = state.nativeRetention?.receipts.find(row => row.operationId === held.operationId);
                if (!receipt || receipt.ownerHash !== held.ownerHash || receipt.partition !== held.account.partition
                    || receipt.generation !== held.lease.generation || receipt.intentFingerprint !== held.intentFingerprint) {
                    fail("NATIVE_RETENTION_OPERATION_OWNER", 403);
                }
                return receipt;
            };
            availableState(state);
            const receipt = check();
            if (receipt.firstFailure) return false;
            await lock();
            check();
            // The original dispatched ticket authorizes only this metadata, not a revoked content read or commit.
            held.failureRecorded = true;
            receipt.firstFailure = evidence;
            const progress = nativeBackfillFor(sourceProgress);
            // Original diagnostics survive withdrawal; deleted progress does not.
            if (progress && activityDeletionVersion(state) === held.deletionVersion && (progress.deletionVersion ?? 0) === held.deletionVersion) {
                const previous = state.nativeRetention.backfill?.find(row => row.accountRef === held.account.partition);
                for (const source of progress.sources) {
                    const committedSource = previous?.sources.find(row => row.surface === source.surface);
                    // Rotation is confirmed commit progress, not a discovery diagnostic.
                    for (const key of ["coworkCursor", "chatCursor"]) {
                        if (committedSource?.[key]) source[key] = copy(committedSource[key]);
                        else delete source[key];
                    }
                    for (const history of source.histories) {
                        const committed = committedSource?.histories.find(row => row.key === history.key);
                        if (["handled", "suppressed"].includes(history.state) && committed?.handledActivity !== history.activity) {
                            history.state = "pending";
                            history.handledActivity = committed?.handledActivity ?? null;
                        }
                        history.handledThrough = committed?.handledThrough ?? null;
                    }
                }
                applyBackfill(state, held, ticket, progress);
            }
            state.revision++;
            const assertCurrent = () => { check(); };
            await save(state, assertCurrent);
            await verifyBoardStatePublication(context, state, assertCurrent);
            return true;
        });
    }
    async function recordBackfill(ticket, envelopes, comparison) {
        const progress = nativeBackfillFor(envelopes);
        if (!progress) return;
        current();
        const held = tickets.get(ticket);
        if (!held || held.retired || !held.consumed || sourceComparisons.get(ticket) !== comparison) fail("NATIVE_BACKFILL_TICKET_INVALID");
        if (!["matched", "suppressed"].includes(comparison.status)
            && !(comparison.status === "unverified" && comparison.reason === "empty-source" && envelopes.length === 0)) {
            fail("NATIVE_BACKFILL_COMPARISON_UNVERIFIED");
        }
        await lifecycle.assertLease(held.lease);
        await lock();
        return admit(held.lease, () => exclusiveBoard(context, async (state, save) => {
            checkFence(state, held);
            const receipt = state.nativeRetention.receipts.find(row => row.operationId === held.operationId);
            if (receipt?.status !== "committed") fail("NATIVE_BACKFILL_COMMIT_REQUIRED");
            const source = encodeNativeRetainedCapture(held.account, envelopes);
            if (nativeRetentionHash(source) !== receipt.fingerprint) fail("NATIVE_BACKFILL_SOURCE_CHANGED");
            const allowed = filterNativeRetainedCapture(source, state.deletion);
            const key = row => nativeRetentionHash([row.content.scope.surface, row.content.scope.conversationId]);
            const observed = new Set(source.observations.map(key)), retained = new Set(allowed.capture.observations.map(key));
            for (const surface of progress.sources) for (const history of surface.histories) {
                const revisit = history.state === "pending" && history.handledActivity === history.activity
                    && history.handledThrough !== null;
                if (observed.has(history.key) && (["handled", "suppressed"].includes(history.state) || revisit)) {
                    history.handledActivity = history.activity;
                    history.state = retained.has(history.key) ? revisit ? "pending" : "handled" : "suppressed";
                }
            }
            if (!applyBackfill(state, held, ticket, progress)) return;
            state.revision++;
            await save(state, () => { checkFence(state, held); });
            await verifyBoardStatePublication(context, state, () => { checkFence(state, held); });
        }));
    }
    async function commitWithFormat(ticket, envelopes, segmented) {
        current();
        const held = tickets.get(ticket);
        if (!held) fail("NATIVE_RETENTION_TICKET_INVALID", 403);
        if (Boolean(held.storageIntent) !== segmented) fail("NATIVE_RETENTION_TICKET_FORMAT", 403);
        checkRequest(held.admission);
        const prior = await receiptFor(held.operationId, held.admission);
        if (held.retired) {
            if (prior?.status === "committed") return publicReceipt(prior);
            fail("NATIVE_RETENTION_TICKET_RETIRED", 403);
        }
        const captured = encodeNativeRetainedCapture(held.account, envelopes);
        const fingerprint = nativeRetentionHash(captured);
        if (prior?.status === "committed") {
            if (prior.fingerprint !== fingerprint) fail("NATIVE_RETENTION_OPERATION_CONFLICT");
            held.consumed = true; activeOperations.delete(held.operationId);
            return publicReceipt(prior);
        }
        if (held.failureRecorded) fail("NATIVE_RETENTION_TICKET_FAILED", 403);
        if (prior?.status !== "registered" || prior.intentFingerprint !== held.intentFingerprint) fail("NATIVE_RETENTION_OPERATION_CONFLICT");
        if (held.consumed) fail("NATIVE_RETENTION_TICKET_CONSUMED");
        await lifecycle.assertLease(held.lease); await lock();
        return admit(held.lease, () => exclusiveBoard(context, async (state, save) => {
            const saved = checkFence(state, held);
            await lock();
            const duplicate = saved.receipts.find(item => item.operationId === held.operationId);
            if (duplicate?.status === "committed") {
                if (duplicate.partition !== held.account.partition || duplicate.ownerHash !== held.ownerHash
                    || duplicate.fingerprint !== fingerprint) fail("NATIVE_RETENTION_OPERATION_CONFLICT");
                return publicReceipt(duplicate);
            }
            if (!duplicate || duplicate.ownerHash !== held.ownerHash || duplicate.partition !== held.account.partition
                || duplicate.intentFingerprint !== held.intentFingerprint) fail("NATIVE_RETENTION_OPERATION_CONFLICT");
            if (captured.observations.some(item => !saved.surfaces.includes(item.content.scope.surface))) fail("NATIVE_RETENTION_SOURCE_NOT_CONFIGURED", 403);
            const previous = saved.partitions.find(item => item.partition === held.account.partition);
            if (!segmented && previous?.format === "segments-v2") fail("NATIVE_SEGMENTED_MERGE_REQUIRED", 503);
            const before = previous && previous.format !== "segments-v2" ? await readDocument(previous.file, "validate-pre-stage") : null;
            const allowed = filterNativeRetainedCapture(captured, state.deletion);
            let document, changes, file, snapshot;
            if (segmented) {
                await lock(); checkFence(state, held); dispatched(held.admission);
                const storage = {
                    capture: allowed.capture,
                    assertCurrent: () => { checkFence(state, held); },
                    async writeBlock(value) {
                        await lock(); checkFence(state, held);
                        const staged = await stagePrivateEvidence(context, value.json, { maxBytes: NATIVE_READ_LIMITS.bytes });
                        await lock(); checkFence(state, held);
                        return staged.slice(0, -5);
                    },
                    async readBlock(hash, { maxBytes }) {
                        await lock(); checkFence(state, held);
                        const bytes = await readPrivateEvidenceBytes(context, `${hash}.json`, { maxBytes });
                        await lock(); checkFence(state, held);
                        return bytes;
                    },
                };
                const blocked = new Set(state.deletion?.identities ?? []);
                const prepared = previous?.format === "segments-v2"
                    ? await stageNativeSegmentedCapture({ ...storage, rootHash: previous.file.slice(0, -5),
                        assertObservationRetained(identity) {
                            if (nativeObservationDeletionAliases(identity).some(key => blocked.has(key))) fail("NATIVE_SEGMENTED_DELETION_REQUIRED", 503);
                        } })
                    : await stageNativeV1Capture({ ...storage,
                        previous: before ? filterNativeRetainedDocument(before, state.deletion) : null });
                changes = prepared.changes; snapshot = prepared.candidate.rootHash; file = `${snapshot}.json`;
            } else {
                const merged = validateAt("validate-pre-stage", () =>
                    mergeNativeRetainedCapture(before ? filterNativeRetainedDocument(before, state.deletion) : null, allowed.capture));
                document = validateAt("validate-pre-stage", () => filterNativeRetainedDocument(merged.document, state.deletion));
                validateAt("validate-pre-stage", () => validateNativeRetainedDocument(document));
                if (nativeValueHasCredentials(document)) fail("NATIVE_RETENTION_PRIVACY_FAILED", 422);
                const content = JSON.stringify(document);
                changes = merged.changes; snapshot = createHash("sha256").update(content).digest("hex");
                await lock(); checkFence(state, held); dispatched(held.admission);
                file = await stagePrivateEvidence(context, content, { maxBytes: NATIVE_READ_LIMITS.bytes });
            }
            await lock(); checkFence(state, held);
            const receipt = { ...duplicate, fingerprint,
                status: "committed", quality: "source-qualified-partial", beforeRevision: state.revision, revision: state.revision + 1,
                configurationRevision: saved.configurationRevision, privacyRevision: saved.privacyRevision,
                generation: held.lease.generation, snapshot,
                changes: { ...changes, suppressedObservations: allowed.suppressedObservations }, committedAt: new Date().toISOString() };
            const next = copy(saved);
            next.partitions = next.partitions.filter(item => item.partition !== held.account.partition);
            next.partitions.push({ partition: held.account.partition, file, revision: receipt.revision, lastOperationId: held.operationId,
                ...(next.schemaVersion === 2 ? { format: segmented ? "segments-v2" : "screened-v1" } : {}) });
            next.receipts = next.receipts.map(item => item.operationId === held.operationId ? receipt : item);
            validateNativeRetentionState(next);
            state.nativeRetention = next; state.stateVersion = 4; state.revision = receipt.revision;
            state.evidenceRevision = (state.evidenceRevision ?? receipt.beforeRevision) + 1;
            await save(state, () => { checkFence({ ...state, nativeRetention: saved }, held); });
            if (segmented) await documentBytes(file);
            else {
                const restored = await readDocument(file, "validate-disk-readback");
                if (nativeRetentionHash(restored) !== nativeRetentionHash(document)) fail("NATIVE_RETENTION_READBACK_FAILED", 500);
            }
            if (committedNativeRetentionIndex(context).retention?.partitions.find(item => item.partition === held.account.partition)?.file !== file) {
                fail("NATIVE_RETENTION_READBACK_FAILED", 500);
            }
            held.consumed = true;
            activeOperations.delete(held.operationId);
            return publicReceipt(receipt);
        }));
    }
    async function compareCommittedSource(ticket, envelopes) {
        const comparison = await compareSource(ticket, envelopes);
        if (ticket && typeof ticket === "object") sourceComparisons.set(ticket, comparison);
        return comparison;
    }
    async function compareSource(ticket, envelopes) {
        const unverified = reason => Object.freeze({ schemaVersion: 1, status: "unverified", reason });
        const held = tickets.get(ticket);
        if (!held || held.retired) return unverified("ticket-unavailable");
        if (held.comparisonAttempted) return unverified("comparison-already-attempted");
        held.comparisonAttempted = true;
        if (envelopes === undefined) return unverified("source-unavailable");
        let failureReason = "retained-access-unavailable";
        try {
            current();
            const lease = await lifecycle.lease("microsoft-retained");
            if (lease.partition !== held.account.partition) return unverified("account-changed");
            function association(state) {
                current(); availableState(state);
                if (held.retired) return unverified("ticket-unavailable");
                const saved = state.nativeRetention;
                const receipt = saved?.receipts.find(item => item.operationId === held.operationId);
                if (!receipt || receipt.status !== "committed") return unverified("operation-not-committed");
                if (receipt.partition !== held.account.partition || receipt.ownerHash !== held.ownerHash
                    || receipt.intent !== "native-collect-now" || receipt.intentFingerprint !== held.intentFingerprint
                    || receipt.configurationRevision !== held.configurationRevision || receipt.privacyRevision !== held.privacyRevision
                    || receipt.generation !== held.lease.generation) return unverified("operation-mismatch");
                const account = saved.accounts.find(item => item.partition === lease.partition);
                if (!account || nativeRetentionHash(account) !== nativeRetentionHash(held.account)) return unverified("account-changed");
                const descriptor = saved.partitions.find(item => item.partition === lease.partition);
                if (!descriptor || descriptor.lastOperationId !== held.operationId || descriptor.revision !== receipt.revision
                    || descriptor.file !== `${receipt.snapshot}.json`) return unverified("snapshot-not-current");
                return { receipt, descriptor };
            }
            failureReason = "stored-document-unavailable";
            const state = await loadBoardState(context, { readOnly: true });
            const bound = association(state);
            if (bound.status === "unverified") return bound;
            const revision = readAuthorized.revision(lease);
            const receiptFingerprint = nativeRetentionHash(bound.receipt);
            const tombstones = nativeRetentionHash(state.deletion?.identities ?? []);
            async function stillCurrent() {
                await setImmediate();
                current();
                await lifecycle.assertLease(lease);
                if (held.retired) return unverified("ticket-unavailable");
                if (readAuthorized.revision(lease) !== revision) return unverified("source-state-changed");
                return null;
            }
            failureReason = "source-invalid";
            const captured = encodeNativeRetainedCapture(held.account, envelopes);
            if (nativeRetentionHash(captured) !== bound.receipt.fingerprint) return unverified("source-mismatch");
            if (!captured.observations.length) return unverified("empty-source");
            const allowed = filterNativeRetainedCapture(captured, state.deletion);
            let stale = await stillCurrent();
            if (stale) return stale;
            failureReason = "stored-document-unavailable";
            if (bound.descriptor.format === "segments-v2") {
                return await admit(lease, () => exclusiveBoard(context, async latest => {
                    const checked = association(latest);
                    if (checked.status === "unverified") return checked;
                    if (nativeRetentionHash(checked.receipt) !== receiptFingerprint) return unverified("operation-mismatch");
                    const assertCurrent = () => {
                        current();
                        if (held.retired || readAuthorized.revision(lease) !== revision
                            || nativeRetentionHash(latest.deletion?.identities ?? []) !== tombstones) {
                            fail("NATIVE_RETENTION_COMPARISON_STALE");
                        }
                    };
                    const reader = await openRetainedQuery(latest, reportStamp(latest, lease), assertCurrent);
                    try {
                        const captures = new Map(allowed.capture.captures.map(item => [item.key, item.value]));
                        const latestVariants = new Map();
                        for (const item of allowed.capture.observations) {
                            assertCurrent();
                            const ref = nativeObservationReference(item.key), captureRef = nativeCaptureReference(item.provenance.captureKey);
                            const variant = await reader.lookupRow(`v/${ref}/${item.contentHash}`);
                            const provenance = await reader.lookupRow(`p/${ref}/${item.contentHash}/${captureRef}/${nativeRetentionHash(item.provenance)}`);
                            const capture = await reader.lookupRow(`c/${captureRef}`);
                            if (!variant || nativeRetentionHash(variant.content) !== nativeRetentionHash(item.content)
                                || !provenance || nativeRetentionHash(provenance.provenance) !== nativeRetentionHash(item.provenance)
                                || !capture || nativeRetentionHash(capture.capture) !== nativeRetentionHash(captures.get(item.provenance.captureKey))) {
                                return unverified("retained-source-mismatch");
                            }
                            latestVariants.set(ref, item.contentHash);
                        }
                        for (const [ref, contentHash] of latestVariants) {
                            const observation = await reader.lookupRow(`o/${ref}`);
                            if (!observation || observation.currentVariant !== contentHash) return unverified("retained-source-mismatch");
                        }
                        assertCurrent();
                        return Object.freeze({ schemaVersion: 1, status: allowed.capture.observations.length ? "matched" : "suppressed",
                            sourceObservationInputs: captured.observations.length,
                            retainedObservationInputs: allowed.capture.observations.length,
                            suppressedObservations: allowed.suppressedObservations });
                    } finally { reader.close(); }
                }, { readOnly: true }));
            }
            const document = await readDocument(bound.descriptor.file, "validate-retained-read");
            if (nativeRetentionHash(document.account) !== nativeRetentionHash(held.account)) return unverified("account-changed");
            const fingerprint = nativeRetentionHash(document);
            if (nativeRetentionHash(filterNativeRetainedDocument(document, state.deletion)) !== fingerprint) {
                return unverified("tombstone-mismatch");
            }
            stale = await stillCurrent();
            if (stale) return stale;
            const expected = mergeNativeRetainedCapture(document, allowed.capture);
            if (nativeRetentionHash(expected.document) !== fingerprint) return unverified("retained-source-mismatch");
            stale = await stillCurrent();
            if (stale) return stale;
            return await admit(lease, () => exclusiveBoard(context, latest => {
                const checked = association(latest);
                if (checked.status === "unverified") return checked;
                if (nativeRetentionHash(checked.receipt) !== receiptFingerprint) return unverified("operation-mismatch");
                if (readAuthorized.revision(lease) !== revision
                    || nativeRetentionHash(latest.deletion?.identities ?? []) !== tombstones) return unverified("source-state-changed");
                return Object.freeze({ schemaVersion: 1,
                    status: allowed.capture.observations.length ? "matched" : "suppressed",
                    sourceObservationInputs: captured.observations.length,
                    retainedObservationInputs: allowed.capture.observations.length,
                    suppressedObservations: allowed.suppressedObservations });
            }, { readOnly: true }));
        } catch (error) {
            if (error instanceof MicrosoftSessionError
                || error instanceof BoardError && error.code === "NATIVE_RETENTION_CLOSED") return unverified("retained-access-unavailable");
            if (error instanceof NativeReadModelError || error instanceof NativeSegmentedError || error instanceof BoardError || error instanceof SyntaxError
                || error instanceof TypeError && error.code === "NATIVE_RETENTION_STATE_INVALID"
                || error instanceof Error && ["ENOENT", "EACCES", "EPERM", "EIO", "ENOTDIR", "EISDIR"].includes(error.code)) {
                return unverified(failureReason);
            }
            throw error;
        }
    }
    async function persistCollectionSettings(settings, token) {
        current(); validateNativeCollectionSettings(settings);
        if (typeof lifecycle.assertNativeCollectionSettingsAdmission !== "function") fail("NATIVE_RETENTION_CONTROL_ADMISSION_REQUIRED", 403);
        const stamp = lifecycle.assertNativeCollectionSettingsAdmission(token);
        if (JSON.stringify(stamp.settings) !== JSON.stringify(settings)) fail("NATIVE_RETENTION_CONTROL_CONFLICT", 403);
        await lock();
        return exclusiveBoard(context, async (state, save) => {
            lifecycle.assertNativeCollectionSettingsAdmission(token); availableState(state); await lock();
            const previous = state.nativeRetention;
            const assertCurrent = () => {
                const current = lifecycle.assertNativeCollectionSettingsAdmission(token);
                if (sourceAware && current.globalRevision !== (state.globalCollection?.revision ?? null)) fail("NATIVE_RETENTION_GLOBAL_CHANGED");
            };
            assertCurrent();
            if (configurationIntents && !settings.paused
                && !previous?.accounts.some(account => account.partition === stamp.partition)) fail("NATIVE_RETENTION_NOT_CONFIGURED", 428);
            const committedSettings = { paused: settings.paused, windowDays: previous?.settings.windowDays ?? settings.windowDays };
            const next = previous ? copy(previous) : initial(committedSettings);
            if (previous && JSON.stringify(previous.settings) === JSON.stringify(committedSettings)) return Object.freeze(copy(committedSettings));
            if (previous) next.configurationRevision++;
            next.settings = copy(committedSettings);
            validateNativeRetentionState(next);
            if (nativeValueHasCredentials(next)) fail("NATIVE_RETENTION_PRIVACY_FAILED", 422);
            assertCurrent();
            state.nativeRetention = next; state.stateVersion = 4; state.revision++;
            await save(state, assertCurrent);
            return Object.freeze(copy(committedSettings));
        });
    }
    function readbackFor(state, lease, descriptor) {
        const receipt = descriptor ? state.nativeRetention.receipts.find(item => item.operationId === descriptor.lastOperationId
            && item.partition === lease.partition && item.snapshot === descriptor.file.slice(0, -5)) : null;
        return { schemaVersion: 1, accountRef: lease.partition, snapshot: descriptor?.file.slice(0, -5) ?? null,
            committed: receipt ? { operationId: receipt.operationId, revision: receipt.revision, generation: receipt.generation,
                configurationRevision: receipt.configurationRevision, privacyRevision: receipt.privacyRevision,
                committedAt: receipt.committedAt } : null,
            current: { generation: lease.generation, configurationRevision: state.nativeRetention?.configurationRevision ?? null,
                privacyRevision: state.nativeRetention?.privacyRevision ?? null } };
    }
    async function readAuthorized(lease) {
        current();
        if (lease?.kind !== "microsoft-retained") fail("NATIVE_RETENTION_READ_LEASE_REQUIRED", 403);
        await lifecycle.assertLease(lease);
        const state = await loadBoardState(context, { readOnly: true });
        availableState(state);
        const descriptor = state.nativeRetention?.partitions.find(item => item.partition === lease.partition);
        const readback = readbackFor(state, lease, descriptor);
        if (!descriptor) {
            await lifecycle.assertLease(lease); current();
            return { contractVersion: NATIVE_RETAINED_CONTRACT, records: [], readback };
        }
        const document = await readDocument(descriptor.file, "validate-retained-read");
        const account = state.nativeRetention.accounts.find(item => item.partition === lease.partition);
        if (nativeRetentionHash(document.account) !== nativeRetentionHash(account)) fail("NATIVE_RETENTION_ACCOUNT_CHANGED", 403);
        const value = validateAt("validate-retained-read", () =>
            validateNativeRetainedDocument(filterNativeRetainedDocument(document, state.deletion)));
        await lifecycle.assertLease(lease);
        current();
        return { ...value, readback };
    }
    function sourceRevision(retention, partition, deletionVersion) {
        return nativeRetentionHash({ contractVersion: NATIVE_RETAINED_CONTRACT, partition,
            configurationRevision: retention?.configurationRevision ?? null, privacyRevision: retention?.privacyRevision ?? null,
            descriptor: retention?.partitions.find(item => item.partition === partition) ?? null, deletionVersion });
    }
    readAuthorized.revision = lease => {
        current();
        if (lease?.kind !== "microsoft-retained" || !/^[a-f0-9]{64}$/.test(lease.partition)) fail("NATIVE_RETENTION_READ_LEASE_REQUIRED", 403);
        const index = committedNativeRetentionIndex(context);
        if (index.deletionPending) fail("NATIVE_RETENTION_DELETION_PENDING", 503);
        return sourceRevision(index.retention, lease.partition, index.deletionVersion);
    };
    if (preAccount === "metadata-only") Object.defineProperty(readAuthorized, "preAccount", { value: preAccount });
    async function status(input = {}, request) {
        current();
        if (!object(input) || !exact(input, Object.hasOwn(input, "operationId") ? ["operationId"] : [])
            || input.operationId !== undefined && !uuid(input.operationId)) fail("NATIVE_RETENTION_OPERATION_INVALID", 422);
        if (preAccount === "metadata-only" && !Object.hasOwn(input, "operationId")) {
            const access = await lifecycle.status();
            if (access.wire === "signed-in" && access.authorization.retained === true
                && access.authorization.microsoftPartition === null) {
                const lease = await lifecycle.lease("retained");
                const state = await loadBoardState(context, { readOnly: true });
                availableState(state);
                if (request !== undefined) operationOwner(request);
                return admit(lease, () => {
                    current();
                    if (!Number.isSafeInteger(access.authorizationRevision) || access.authorizationRevision < 0
                        || authorization?.retained !== true || authorization.generation !== lease.generation
                        || lease.generation !== access.generation || authorization.revision !== access.authorizationRevision) {
                        fail("NATIVE_RETENTION_UNAVAILABLE_STALE");
                    }
                    return Object.freeze({ schemaVersion: 1, kind: "native-account-unavailable",
                        reason: "microsoft-account-not-configured", generation: lease.generation,
                        authorizationRevision: access.authorizationRevision, revision: state.revision,
                        rawWriterAdmission: "withheld", configured: false, configuration: configuration(state.nativeRetention),
                        actions: Object.freeze([]), blockers: Object.freeze(["NATIVE_RETENTION_ACCOUNT_UNAVAILABLE"]) });
                });
            }
        }
        const lease = await lifecycle.lease("microsoft-retained");
        const state = await loadBoardState(context, { readOnly: true });
        const access = await lifecycle.status();
        await lifecycle.assertLease(lease);
        current();
        const value = state.nativeRetention;
        const ownerHash = request === undefined ? null : operationOwner(request);
        if (input.operationId !== undefined && ownerHash === null) fail("NATIVE_RETENTION_OPERATION_OWNER_REQUIRED", 403);
        const requested = input.operationId === undefined ? null : value?.receipts.find(item => item.operationId === input.operationId)
            ?? await readArchivedNativeReceipt(context, value, input.operationId);
        await lifecycle.assertLease(lease);
        current();
        if (requested && (requested.partition !== lease.partition || requested.ownerHash !== ownerHash)) {
            fail("NATIVE_RETENTION_OPERATION_OWNER", 403);
        }
        const latest = input.operationId === undefined
            ? value?.receipts.findLast(item => item.partition === lease.partition && item.ownerHash === ownerHash)
            : requested;
        const configured = Boolean(value?.accounts.some(item => item.partition === lease.partition));
        const blockers = [];
        if (!configured) blockers.push("NATIVE_RETENTION_NOT_CONFIGURED");
        if (value?.settings.paused) blockers.push("NATIVE_RETENTION_PAUSED");
        if (state.globalCollection?.paused) blockers.push("NATIVE_RETENTION_GLOBAL_PAUSED");
        if (!access.authorization.microsoftAcquisition) blockers.push("NATIVE_RETENTION_ACQUISITION_UNAVAILABLE");
        if (value && !nativeReceiptCapacityAvailable(value, issuedOperations)) blockers.push("NATIVE_RETENTION_RECEIPT_LIMIT");
        if ([...activeOperations.values()].some(ticket => ticket.lease.partition === lease.partition)) blockers.push("NATIVE_RETENTION_OPERATION_PENDING");
        const latestPartitionReceipt = value?.receipts.findLast(receipt => receipt.partition === lease.partition);
        if (latestPartitionReceipt?.status === "registered" && !activeOperations.has(latestPartitionReceipt.operationId)) {
            blockers.push("NATIVE_RETENTION_OPERATION_UNKNOWN");
        }
        const actions = [];
        if (access.authorization.microsoftAcquisition && !configurationIntents) actions.push("configure");
        if (configured && blockers.every(code => code === "NATIVE_RETENTION_OPERATION_UNKNOWN")) actions.push("collect-now");
        const backfill = value?.backfill?.find(row => row.accountRef === lease.partition
            && (row.deletionVersion ?? 0) === activityDeletionVersion(state)
            && row.privacyRevision === value.privacyRevision && row.windowDays === value.settings.windowDays
            && JSON.stringify(row.sources.map(source => source.surface).sort()) === JSON.stringify([...value.surfaces].sort()));
        return { schemaVersion: 1, kind: "native-screened-retention", contractVersion: NATIVE_RETAINED_CONTRACT,
            rawWriterAdmission: "withheld", configured, accountRef: lease.partition, generation: lease.generation,
            revision: state.revision, actions, blockers, configuration: configuration(value),
            receiptQuery: input.operationId ?? null, receipt: latest ? publicReceipt(latest, activeOperations.has(latest.operationId)) : null,
            ...(backfill ? { backfill: nativeBackfillSummary(backfill) } : {}) };
    }
    function reportStamp(state, lease) {
        availableState(state);
        const retained = state.nativeRetention;
        const account = retained?.accounts.find(item => item.partition === lease.partition);
        const descriptor = retained?.partitions.find(item => item.partition === lease.partition);
        if (!account || !descriptor) fail("NATIVE_REPORT_COMMITTED_SOURCE_REQUIRED", 503);
        return { account, descriptor, pseudonymKey: state.pseudonymKey, configurationRevision: retained.configurationRevision,
            privacyRevision: retained.privacyRevision, deletionVersion: activityDeletionVersion(state),
            sourceRevision: sourceRevision(retained, lease.partition, activityDeletionVersion(state)) };
    }
    function reportAuthority(stamp) {
        // Prepared frames pin content-addressed bytes, not the advancing collection pointer.
        const { descriptor, sourceRevision, ...authority } = stamp;
        return nativeRetentionHash(authority);
    }
    function assertReportAuthority(state, owned) {
        if (reportAuthority(reportStamp(state, owned.lease)) !== reportAuthority(owned.stamp)) {
            fail("NATIVE_REPORT_SOURCE_STALE");
        }
    }
    function ownedReport(frame, request) {
        current(); request = admission(request); checkRequest(request);
        const owned = reportFrames.get(frame);
        if (!owned || owned.ownerHash !== operationOwner(request)) fail("NATIVE_REPORT_FRAME_INVALID", 403);
        if (owned.consumed) fail("NATIVE_REPORT_FRAME_CONSUMED");
        return owned;
    }
    function freezeReport(value) {
        if (value && typeof value === "object" && !Object.isFrozen(value)) {
            Object.values(value).forEach(freezeReport);
            Object.freeze(value);
        }
        return value;
    }
    function reportReference(state, domain, ...values) {
        return createHmac("sha256", state.pseudonymKey).update(JSON.stringify([domain, ...values])).digest("hex");
    }
    function reportSourceHeader(state, lease, stamp, definitions) {
        return freezeReport({ schemaVersion: 1, contractVersion: NATIVE_RETAINED_CONTRACT, policy: NATIVE_RETENTION_POLICY_ID,
            sourceSnapshotRef: reportReference(state, "native-report-snapshot-v1", lease.partition, stamp.descriptor.file),
            sourceRevisionRef: reportReference(state, "native-report-source-revision-v1", lease.partition, stamp.sourceRevision),
            configurationRevision: stamp.configurationRevision, privacyRevision: stamp.privacyRevision,
            deletionVersion: stamp.deletionVersion, definitions });
    }
    async function openRetainedQuery(state, stamp, assertCurrent) {
        const rootHash = stamp.descriptor.file.slice(0, -5);
        assertCurrent();
        if (stamp.descriptor.format !== "segments-v2") {
            const bytes = await documentBytes(stamp.descriptor.file);
            assertCurrent();
            return openNativeLegacyReader({ bytes, rootHash, expectedAccount: stamp.account,
                assertCurrent, deletion: state.deletion });
        }
        const reader = await openNativeSegmentedReader({ rootHash, expectedAccount: stamp.account, assertCurrent,
            async readBlock(hash, { maxBytes }) {
                assertCurrent();
                const bytes = await readPrivateEvidenceBytes(context, `${hash}.json`, { maxBytes });
                assertCurrent();
                return bytes;
            } });
        try {
            const blocked = new Set(state.deletion?.identities ?? []);
            if (blocked.size) for await (const row of reader.iterateRows({ prefix: "o/" })) {
                if (nativeObservationDeletionAliases(row.identity).some(key => blocked.has(key))) fail("NATIVE_SEGMENTED_DELETION_REQUIRED", 503);
            }
            assertCurrent();
            return reader;
        } catch (error) { reader.close(); throw error; }
    }
    async function withReadBinding(input, request, work) {
        current(); request = admission(request); checkRequest(request);
        const ownerHash = operationOwner(request);
        if (!exact(input, ["revision"]) || input.revision !== null && (!Number.isSafeInteger(input.revision) || input.revision < 0)
            || typeof work !== "function") fail("NATIVE_REPORT_SELECTION_INVALID", 422);
        const lease = await lifecycle.lease("microsoft-retained");
        return admit(lease, () => exclusiveBoard(context, async state => {
            checkRequest(request);
            if (input.revision !== null && state.revision !== input.revision) fail("NATIVE_REPORT_SOURCE_STALE");
            const stamp = reportStamp(state, lease), fingerprint = nativeRetentionHash(stamp), revision = state.revision;
            let active = true, reader, view;
            const assertCurrent = () => {
                if (!active) fail("NATIVE_REPORT_ADMISSION_EXPIRED", 403);
                checkRequest(request);
                if (operationOwner(request) !== ownerHash) fail("NATIVE_RETENTION_OPERATION_OWNER", 403);
                if (state.revision !== revision || nativeRetentionHash(reportStamp(state, lease)) !== fingerprint) fail("NATIVE_REPORT_SOURCE_STALE");
            };
            try {
                reader = await openRetainedQuery(state, stamp, assertCurrent);
                assertCurrent();
                view = Object.freeze({ ...reader, revision, storageFormat: stamp.descriptor.format ?? "screened-v1",
                    source: reportSourceHeader(state, lease, stamp, reader.definitions),
                    readback: freezeReport(readbackFor(state, lease, stamp.descriptor)) });
                readerBindings.set(view, { ownerHash, lease, stamp, revision, assertCurrent });
                const result = await work(view, assertCurrent, state, { ownerHash, lease, stamp, fingerprint });
                assertCurrent();
                return result;
            } finally { active = false; if (view) readerBindings.delete(view); reader?.close(); }
        }, { readOnly: true }));
    }
    const withRetainedReader = (input, request, work) => {
        if (typeof work !== "function") fail("NATIVE_REPORT_CALLBACK_INVALID", 422);
        return withReadBinding(input, request, (reader, assertCurrent, state) => work(reader, assertCurrent, state));
    };
    function pinRetainedReader(reader, request) {
        current(); request = admission(request); checkRequest(request);
        const binding = readerBindings.get(reader);
        if (!binding || binding.ownerHash !== operationOwner(request)) fail("NATIVE_READER_FRAME_INVALID", 403);
        binding.assertCurrent();
        const frame = Object.freeze({});
        retainedReaderFrames.set(frame, { ownerHash: binding.ownerHash, lease: binding.lease, revision: binding.revision,
            stamp: freezeReport(copy(binding.stamp)), readback: freezeReport(copy(reader.readback)) });
        return frame;
    }
    async function withPinnedRetainedReader(frame, request, work) {
        current(); request = admission(request); checkRequest(request);
        const owned = retainedReaderFrames.get(frame);
        if (!owned || owned.ownerHash !== operationOwner(request)) fail("NATIVE_READER_FRAME_INVALID", 403);
        if (typeof work !== "function") fail("NATIVE_REPORT_CALLBACK_INVALID", 422);
        return admit(owned.lease, () => exclusiveBoard(context, async state => {
            const revision = state.revision;
            let active = true, reader;
            const assertCurrent = () => {
                if (!active) fail("NATIVE_REPORT_ADMISSION_EXPIRED", 403);
                checkRequest(request);
                if (retainedReaderFrames.get(frame) !== owned || operationOwner(request) !== owned.ownerHash) fail("NATIVE_READER_FRAME_INVALID", 403);
                if (state.revision !== revision) fail("NATIVE_REPORT_SOURCE_STALE");
                assertReportAuthority(state, owned);
            };
            try {
                assertCurrent();
                reader = await openRetainedQuery(state, owned.stamp, assertCurrent);
                const view = Object.freeze({ ...reader, revision: owned.revision,
                    storageFormat: owned.stamp.descriptor.format ?? "screened-v1",
                    source: reportSourceHeader(state, owned.lease, owned.stamp, reader.definitions), readback: owned.readback });
                const result = await work(view, assertCurrent, state);
                assertCurrent();
                return result;
            } finally { active = false; reader?.close(); }
        }, { readOnly: true }));
    }
    const releaseRetainedReader = frame => retainedReaderFrames.delete(frame);
    async function selectedOriginalRecords(reader, selection, assertCurrent) {
        if (selection.expected.variants > NATIVE_READ_LIMITS.records) fail("NATIVE_REPORT_SELECTION_BOUND", 422);
        const entries = [], envelope = measureNativeJson({ contractVersion: NATIVE_RETAINED_CONTRACT, entries: [] });
        let bytes = 0, nodes = 0, complete = false;
        for await (const event of reader.iterate(selection)) {
            assertCurrent();
            if (event.kind === "selection-end") complete = true;
            if (event.kind !== "conversation-part") continue;
            for (const entry of event.entries) {
                const size = measureNativeJson(entry);
                if (entries.length >= NATIVE_READ_LIMITS.records
                    || bytes + size.bytes + (entries.length ? 1 : 0) + envelope.bytes > NATIVE_READ_LIMITS.bytes
                    || nodes + size.nodes + envelope.nodes > NATIVE_JSON_LIMITS.nodes) fail("NATIVE_REPORT_SELECTION_BOUND", 422);
                bytes += size.bytes + (entries.length ? 1 : 0); nodes += size.nodes;
                entries.push(entry);
            }
        }
        if (!complete) fail("NATIVE_REPORT_SELECTION_INCOMPLETE", 422);
        assertCurrent();
        return projectRetainedNativeEntries({ contractVersion: NATIVE_RETAINED_CONTRACT, entries });
    }
    async function validateSelectionSource(state, owned, assertCurrent, original = false) {
        if (!owned.query) { await documentBytes(owned.file); return; }
        assertReportAuthority(state, owned);
        const stamp = owned.stamp;
        const reader = await openRetainedQuery(state, stamp, assertCurrent);
        try {
            const selection = await reader.select(owned.query);
            assertCurrent();
            if (nativeRetentionHash(selection) !== nativeRetentionHash(owned.selection)) fail("NATIVE_REPORT_SOURCE_STALE");
            if (original) {
                const canonical = await selectedOriginalRecords(reader, selection, assertCurrent);
                const source = reportSourceHeader(state, owned.lease, stamp, reader.definitions);
                const expectations = nativeReportSelectionExpectations(canonical.records, source.definitions, state.pseudonymKey);
                if (nativeRetentionHash(source) !== nativeRetentionHash(owned.source)
                    || nativeRetentionHash(expectations) !== nativeRetentionHash(owned.originalViewExpectations)) fail("NATIVE_REPORT_SOURCE_STALE");
                return { records: canonical.records, source };
            }
        } finally { reader.close(); }
    }
    const reportSource = Object.freeze({
        artifactMutationAdmission: request => createNativeArtifactMutationAdmission(context, lifecycle, request, current, lock),
        async captureSelection(input, request) {
            current(); request = admission(request); checkRequest(request); operationOwner(request);
            if (!exact(input, ["revision", "sources", "scenarioIds"]) || !Number.isSafeInteger(input.revision) || input.revision < 0
                || !Array.isArray(input.scenarioIds)) fail("NATIVE_REPORT_SELECTION_INVALID", 422);
            const query = normalizeNativeSelectionQuery({ sources: input.sources, scenarioIds: input.scenarioIds });
            return withReadBinding({ revision: input.revision }, request, async (reader, assertCurrent, state, binding) => {
                const selection = await reader.select(query);
                const canonical = await selectedOriginalRecords(reader, selection, assertCurrent);
                const frame = freezeReport({ source: reader.source, selection,
                    originalViewExpectations: nativeReportSelectionExpectations(canonical.records, reader.source.definitions, state.pseudonymKey) });
                assertCurrent();
                reportFrames.set(frame, { ownerHash: binding.ownerHash, lease: binding.lease, fingerprint: binding.fingerprint,
                    stamp: freezeReport(copy(binding.stamp)), file: binding.stamp.descriptor.file, consumed: false, query, selection,
                    source: frame.source, originalViewExpectations: frame.originalViewExpectations });
                return frame;
            });
        },
        async iterateSelection(frame, request, work) {
            const owned = ownedReport(frame, request);
            if (!owned.query || typeof work !== "function") fail("NATIVE_REPORT_CALLBACK_INVALID", 422);
            return admit(owned.lease, () => exclusiveBoard(context, async state => {
                let active = true, reader, iterator, complete = false;
                const assertCurrent = () => {
                    if (!active) fail("NATIVE_REPORT_ADMISSION_EXPIRED", 403);
                    ownedReport(frame, request);
                    assertReportAuthority(state, owned);
                };
                try {
                    assertCurrent();
                    reader = await openRetainedQuery(state, owned.stamp, assertCurrent);
                    const selection = await reader.select(owned.query);
                    if (nativeRetentionHash(selection) !== nativeRetentionHash(owned.selection)) fail("NATIVE_REPORT_SOURCE_STALE");
                    iterator = reader.iterate(selection);
                    const events = Object.freeze({
                        [Symbol.asyncIterator]() { return this; },
                        async next() {
                            assertCurrent();
                            const result = await iterator.next();
                            assertCurrent();
                            if (result.value?.kind === "selection-end") complete = true;
                            return result;
                        },
                        async return() { return iterator.return(); },
                    });
                    const result = await work(events, assertCurrent, state);
                    assertCurrent();
                    if (!complete) fail("NATIVE_REPORT_SELECTION_INCOMPLETE", 422);
                    return result;
                } finally {
                    active = false;
                    try { await iterator?.return(); } finally { reader?.close(); }
                }
            }, { readOnly: true }));
        },
        async capture(input, request) {
            current(); request = admission(request); checkRequest(request);
            const ownerHash = operationOwner(request);
            if (!exact(input, ["revision", "scenarioIds"]) || !Number.isSafeInteger(input.revision) || input.revision < 0
                || !Array.isArray(input.scenarioIds) || !input.scenarioIds.length || input.scenarioIds.length > NATIVE_READ_LIMITS.records
                || input.scenarioIds.some(id => typeof id !== "string" || !id)
                || new Set(input.scenarioIds).size !== input.scenarioIds.length) fail("NATIVE_REPORT_SELECTION_INVALID", 422);
            if (nativeValueHasCredentials(input)) fail("NATIVE_REPORT_SELECTION_INVALID", 422);
            const selected = new Set(input.scenarioIds);
            const lease = await lifecycle.lease("microsoft-retained");
            const state = await loadBoardState(context, { readOnly: true });
            if (state.revision !== input.revision) fail("NATIVE_REPORT_SOURCE_STALE");
            const stamp = reportStamp(state, lease), fingerprint = nativeRetentionHash(stamp);
            const document = await readDocument(stamp.descriptor.file, "validate-retained-read");
            if (nativeRetentionHash(document.account) !== nativeRetentionHash(stamp.account)) fail("NATIVE_RETENTION_ACCOUNT_CHANGED", 403);
            const retained = validateAt("validate-retained-read", () =>
                validateNativeRetainedDocument(filterNativeRetainedDocument(document, state.deletion)));
            const projection = projectRetainedNativeRecords(retained);
            const records = projection.records.filter(record => selected.has(record.scenarioId));
            if (records.length !== selected.size) fail("NATIVE_REPORT_SELECTION_CHANGED");
            return admit(lease, () => exclusiveBoard(context, latest => {
                checkRequest(request);
                if (latest.revision !== input.revision || nativeRetentionHash(reportStamp(latest, lease)) !== fingerprint) {
                    fail("NATIVE_REPORT_SOURCE_STALE");
                }
                const frame = freezeReport({ records, source: { schemaVersion: 1, contractVersion: NATIVE_RETAINED_CONTRACT,
                    policy: NATIVE_RETENTION_POLICY_ID,
                    sourceSnapshotRef: reportReference(latest, "native-report-snapshot-v1", lease.partition, stamp.descriptor.file),
                    sourceRevisionRef: reportReference(latest, "native-report-source-revision-v1", lease.partition, stamp.sourceRevision),
                    configurationRevision: stamp.configurationRevision, privacyRevision: stamp.privacyRevision,
                    deletionVersion: stamp.deletionVersion, definitions: projection.definitions } });
                reportFrames.set(frame, { ownerHash, lease, fingerprint, stamp: freezeReport(copy(stamp)), file: stamp.descriptor.file, consumed: false });
                return frame;
            }, { readOnly: true }));
        },
        async validate(frame, request, publish) {
            const owned = ownedReport(frame, request);
            if (publish !== undefined && typeof publish !== "function") fail("NATIVE_REPORT_CALLBACK_INVALID", 422);
            return admit(owned.lease, () => exclusiveBoard(context, async state => {
                ownedReport(frame, request);
                assertReportAuthority(state, owned);
                const assertCurrent = () => {
                    ownedReport(frame, request);
                    assertReportAuthority(state, owned);
                };
                await validateSelectionSource(state, owned, assertCurrent);
                ownedReport(frame, request);
                assertReportAuthority(state, owned);
                const result = publish?.(state);
                if (result && typeof result.then === "function") {
                    Promise.resolve(result).catch(() => {});
                    fail("NATIVE_REPORT_PUBLICATION_MUST_BE_SYNCHRONOUS", 422);
                }
                return result;
            }, { readOnly: true }));
        },
        async commit(frame, request, work, publication) {
            const owned = ownedReport(frame, request);
            if (owned.query && publication === undefined) fail("NATIVE_REPORT_SELECTION_PUBLICATION_NOT_READY", 503);
            if (publication !== undefined && (!owned.query || !exact(publication, ["bundle", "validate"])
                || typeof publication.validate !== "function")) fail("NATIVE_REPORT_PUBLICATION_INVALID", 422);
            if (typeof work !== "function") fail("NATIVE_REPORT_CALLBACK_INVALID", 422);
            return admit(owned.lease, () => exclusiveBoard(context, async (state, save) => {
                let active = true;
                let revision = state.revision;
                const assertCurrent = () => {
                    if (!active) fail("NATIVE_REPORT_ADMISSION_EXPIRED", 403);
                    checkRequest(request);
                    if (operationOwner(request) !== owned.ownerHash || state.revision !== revision) {
                        fail("NATIVE_REPORT_SOURCE_STALE");
                    }
                    assertReportAuthority(state, owned);
                };
                try {
                    ownedReport(frame, request);
                    if (publication && state.deletion?.pending) fail("NATIVE_REPORT_CLEANUP_PENDING", 503);
                    await lock(); assertCurrent();
                    const original = await validateSelectionSource(state, owned, assertCurrent, Boolean(publication));
                    await lock(); assertCurrent();
                    const previousExports = nativeRetentionHash(state.exports), previousCount = state.exports.length;
                    const unchangedState = () => {
                        const { exports, artifactDeletion, ...rest } = state;
                        return nativeRetentionHash(rest);
                    };
                    const previousState = unchangedState(), previousArtifactState = nativeRetentionHash(state.artifactDeletion ?? null);
                    const priorArtifacts = copy(state.artifactDeletion ?? { schemaVersion: 1, revision: 0, identities: [] });
                    const validatePublication = async () => {
                        if (!publication) return;
                        const valid = await publication.validate(state, assertCurrent);
                        assertCurrent();
                        if (valid !== undefined && valid !== true || unchangedState() !== previousState) fail("NATIVE_REPORT_PUBLICATION_INVALID", 422);
                    };
                    await validatePublication();
                    if (nativeRetentionHash(state.exports) !== previousExports
                        || nativeRetentionHash(state.artifactDeletion ?? null) !== previousArtifactState) fail("NATIVE_REPORT_HISTORY_INVALID", 422);
                    const pinned = publication ? pinNativeReportPublication(publication.bundle, original, state.pseudonymKey) : null;
                    if (pinned) assertArtifactWritable(state, pinned.bundleId, "report");
                    if (publication) { await lock(); assertCurrent(); }
                    owned.consumed = true;
                    dispatched(request);
                    const result = await work(state, assertCurrent);
                    await validateSelectionSource(state, owned, assertCurrent);
                    await lock(); assertCurrent();
                    await validatePublication();
                    if (unchangedState() !== previousState) fail("NATIVE_REPORT_HISTORY_INVALID", 422);
                    if (state.exports.length !== previousCount + 1
                        || nativeRetentionHash(state.exports.slice(0, previousCount)) !== previousExports) fail("NATIVE_REPORT_HISTORY_INVALID", 422);
                    const entry = state.exports.at(-1);
                    if (!object(entry) || Object.hasOwn(entry, "nativeSourceBinding") || (entry.kind ?? "report") !== "report") {
                        fail("NATIVE_REPORT_HISTORY_INVALID", 422);
                    }
                    assertArtifactWritable({ ...state, exports: state.exports.slice(0, previousCount) }, entry.bundleId, entry.kind ?? "report");
                    if (pinned) {
                        if (nativeRetentionHash(pinNativeReportPublication(publication.bundle, original, state.pseudonymKey)) !== nativeRetentionHash(pinned)
                            || nativeRetentionHash(state.artifactDeletion ?? null) !== nativeRetentionHash({
                                ...priorArtifacts, revision: priorArtifacts.revision + 1,
                            })) fail("NATIVE_REPORT_PUBLICATION_INVALID", 422);
                        assertNativeReportPublicationIndex(context, pinned, entry);
                        await verifyNativeReportPublicationFiles(context, pinned, assertCurrent);
                        await validatePublication();
                        if (state.exports.length !== previousCount + 1 || nativeRetentionHash(state.exports.slice(0, previousCount)) !== previousExports) {
                            fail("NATIVE_REPORT_HISTORY_INVALID", 422);
                        }
                        assertNativeReportPublicationIndex(context, pinned, state.exports[previousCount]);
                        if (nativeRetentionHash(state.artifactDeletion ?? null) !== nativeRetentionHash({
                            ...priorArtifacts, revision: priorArtifacts.revision + 1,
                        })) fail("NATIVE_REPORT_PUBLICATION_INVALID", 422);
                    }
                    state.exports[previousCount] = validateNativeReportEntry({ ...state.exports[previousCount], nativeSourceBinding: { schemaVersion: 1,
                        account: reportReference(state, "native-report-account-v1", owned.lease.partition) } });
                    state.nativeReportPolicy = NATIVE_REPORT_STORAGE_POLICY_ID;
                    state.stateVersion = Math.max(state.stateVersion, 5);
                    state.revision++;
                    revision = state.revision;
                    const publishedState = nativeRetentionHash(state);
                    const assertPublicationCurrent = () => {
                        assertCurrent();
                        if (nativeRetentionHash(state) !== publishedState) fail("NATIVE_REPORT_HISTORY_INVALID", 422);
                    };
                    await save(state, assertPublicationCurrent);
                    if (pinned) {
                        await verifyBoardStatePublication(context, state, assertPublicationCurrent);
                        await verifyNativeReportPublicationFiles(context, pinned, assertPublicationCurrent);
                    }
                    return { state, result };
                } finally { active = false; }
            }));
        },
        async captureSavedComparison(dependencies, request) {
            current(); request = admission(request); checkRequest(request);
            const ownerHash = operationOwner(request), lease = await lifecycle.lease("microsoft-retained");
            return admit(lease, () => exclusiveBoard(context, state => {
                availableState(state); checkRequest(request);
                assertSavedReportDependencies(dependencies, state);
                const account = reportReference(state, "native-report-account-v1", lease.partition);
                const entries = dependencies.map(item => savedArtifact(state, item.bundleId, "report"));
                if (!entries.some(item => item.nativeEvidenceHash)
                    || entries.some(item => item.nativeSourceBinding && validateNativeReportBinding(item.nativeSourceBinding).account !== account)) {
                    fail("NATIVE_REPORT_ACCOUNT_REQUIRED", 403);
                }
                const frame = freezeReport({ sourceReports: dependencies.map(({ bundleId, snapshotHash }) => ({ bundleId, snapshotHash })) });
                savedComparisonFrames.set(frame, { lease, ownerHash, account, dependencies: copy(dependencies),
                    fingerprint: nativeRetentionHash(entries), consumed: false });
                return frame;
            }, { readOnly: true }));
        },
        async withSavedComparison(frame, request, work, publication) {
            current(); request = admission(request); checkRequest(request);
            const owned = savedComparisonFrames.get(frame);
            if (!owned || owned.consumed || operationOwner(request) !== owned.ownerHash) fail("NATIVE_REPORT_SELECTION_INVALID", 403);
            if (typeof work !== "function" || publication !== undefined
                && (!exact(publication, ["bundle", "validate"]) || publication.bundle?.kind !== "comparison"
                    || typeof publication.validate !== "function")) fail("NATIVE_REPORT_PUBLICATION_INVALID", 422);
            return admit(owned.lease, () => exclusiveBoard(context, async (state, save) => {
                availableState(state);
                let active = true;
                const assertCurrent = () => {
                    if (!active) fail("NATIVE_REPORT_ADMISSION_EXPIRED", 403);
                    checkRequest(request);
                    if (operationOwner(request) !== owned.ownerHash) fail("NATIVE_REPORT_SELECTION_INVALID", 403);
                    assertSavedReportDependencies(owned.dependencies, state);
                    const entries = owned.dependencies.map(item => savedArtifact(state, item.bundleId, "report"));
                    if (nativeRetentionHash(entries) !== owned.fingerprint) fail("NATIVE_REPORT_SOURCE_STALE");
                };
                const visible = () => ({ ...state, exports: state.exports.filter(entry => !entry.nativeSourceBinding
                    || validateNativeReportBinding(entry.nativeSourceBinding).account === owned.account)
                    .map(({ nativeSourceBinding, ...entry }) => copy(entry)) });
                try {
                    assertCurrent();
                    if (!publication) {
                        const result = await work(visible(), assertCurrent, state);
                        assertCurrent(); return result;
                    }
                    await lock(); assertCurrent();
                    if (state.deletion?.pending) fail("NATIVE_REPORT_CLEANUP_PENDING", 503);
                    await publication.validate(visible(), assertCurrent); assertCurrent();
                    const pin = pinNativeReportPublication(publication.bundle);
                    if (nativeRetentionHash(pin.sourceReports) !== nativeRetentionHash(frame.sourceReports)) fail("NATIVE_REPORT_PUBLICATION_INVALID", 422);
                    const before = copy(state), count = state.exports.length;
                    const rest = value => { const { exports, artifactDeletion, ...other } = value; return nativeRetentionHash(other); };
                    const priorArtifacts = copy(state.artifactDeletion ?? { schemaVersion: 1, revision: 0, identities: [] });
                    assertArtifactWritable(state, pin.bundleId, "comparison");
                    owned.consumed = true;
                    dispatched(request);
                    const result = await work(visible(), assertCurrent, state);
                    assertCurrent(); await lock(); assertCurrent();
                    const assertIndex = () => {
                        assertCurrent();
                        if (rest(state) !== rest(before) || state.exports.length !== count + 1
                            || nativeRetentionHash(state.exports.slice(0, count)) !== nativeRetentionHash(before.exports)
                            || nativeRetentionHash(state.artifactDeletion) !== nativeRetentionHash({ ...priorArtifacts, revision: priorArtifacts.revision + 1 })
                            || nativeRetentionHash(pinNativeReportPublication(publication.bundle)) !== nativeRetentionHash(pin)) {
                            fail("NATIVE_REPORT_HISTORY_INVALID", 422);
                        }
                        assertNativeReportPublicationIndex(context, pin, state.exports[count]);
                    };
                    assertIndex();
                    await verifyNativeReportPublicationFiles(context, pin, assertIndex);
                    await publication.validate(visible(), assertCurrent); assertIndex();
                    state.exports[count] = validateNativeReportEntry({ ...state.exports[count],
                        nativeSourceBinding: { schemaVersion: 1, account: owned.account } });
                    state.nativeReportPolicy = NATIVE_REPORT_STORAGE_POLICY_ID;
                    state.stateVersion = Math.max(state.stateVersion, 5); state.revision++;
                    const published = nativeRetentionHash(state);
                    const assertPublication = () => {
                        assertCurrent();
                        if (nativeRetentionHash(state) !== published) fail("NATIVE_REPORT_HISTORY_INVALID", 422);
                    };
                    await save(state, assertPublication);
                    await verifyBoardStatePublication(context, state, assertPublication);
                    await verifyNativeReportPublicationFiles(context, pin, assertPublication);
                    return result;
                } finally { active = false; }
            }, { readOnly: publication === undefined }));
        },
        async readSaved(input, request, work) {
            current(); request = admission(request); checkRequest(request); operationOwner(request);
            if (!exact(input, ["bundleIds"]) || input.bundleIds !== null && (!Array.isArray(input.bundleIds)
                || input.bundleIds.length > NATIVE_READ_LIMITS.records || input.bundleIds.some(id => typeof id !== "string"
                    || !/^export-[a-f0-9-]{36}$/.test(id)) || new Set(input.bundleIds).size !== input.bundleIds.length)
                || typeof work !== "function") fail("NATIVE_REPORT_SELECTION_INVALID", 422);
            const access = await lifecycle.status();
            const partition = access.microsoft.partition;
            const lease = await lifecycle.lease(partition ? "microsoft-retained" : "retained");
            if (lease.generation !== access.generation || partition && lease.partition !== partition) fail("NATIVE_REPORT_SOURCE_STALE");
            return admit(lease, () => exclusiveBoard(context, async state => {
                availableState(state); checkRequest(request);
                const account = partition ? reportReference(state, "native-report-account-v1", partition) : null;
                const visible = entry => {
                    if (!Object.hasOwn(entry, "nativeSourceBinding")) return true;
                    const binding = validateNativeReportBinding(entry.nativeSourceBinding);
                    return binding.account === account;
                };
                const entries = input.bundleIds === null ? state.exports.filter(entry =>
                    !state.artifactDeletion?.identities?.includes(artifactDeletionKey(entry.kind ?? "report", entry.bundleId))
                    && visible(entry)) : input.bundleIds.map(id => {
                    const entry = savedArtifact(state, id);
                    if (!visible(entry)) fail("NATIVE_REPORT_ACCOUNT_REQUIRED", 403);
                    return entry;
                });
                const stripped = entries.map(({ nativeSourceBinding, ...entry }) => copy(entry));
                const selectedState = { ...state, exports: stripped };
                let active = true;
                const assertCurrent = () => {
                    if (!active) fail("NATIVE_REPORT_ADMISSION_EXPIRED", 403);
                    checkRequest(request);
                };
                try {
                    const result = await work(selectedState, stripped, assertCurrent, state);
                    assertCurrent();
                    return result;
                } finally { active = false; }
            }, { readOnly: true }));
        },
    });
    reportSources.set(reportSource, owner);
    async function readAccountPresentation(lease) {
        current();
        if (lease?.kind !== "microsoft-retained") fail("NATIVE_RETENTION_ACCOUNT_UNQUALIFIED", 403);
        await lifecycle.assertLease(lease);
        const identity = transport.accountFor(lease), presentation = identity.presentation;
        current();
        await lifecycle.assertLease(lease);
        current();
        if (transport.accountFor(lease) !== identity || identity.partition !== lease.partition
            || presentation && presentation.generation !== lease.generation) fail("NATIVE_RETENTION_ACCOUNT_UNQUALIFIED", 403);
        return presentation ? Object.freeze({ ...presentation }) : null;
    }
    const api = Object.freeze({ configure, begin, commit, beginSegmented, commitSegmented, readAuthorized, withRetainedReader,
        pinRetainedReader, withPinnedRetainedReader, releaseRetainedReader, status,
        compareCommittedSource, persistCollectionSettings, reportSource, readAccountPresentation, recordFailure, recordBackfill,
        localActivityDeletionAdmission: request => createLocalActivityDeletionAdmission(context, lifecycle, request, current, lock),
        retire(ticket) {
            const held = tickets.get(ticket);
            if (!held) fail("NATIVE_RETENTION_TICKET_INVALID", 403);
            held.retired = true;
            if (activeOperations.get(held.operationId) === ticket) activeOperations.delete(held.operationId);
            issuedOperations.delete(held.operationId);
        },
        ...(sourceAware ? { setGlobalCollectionGate } : {}),
        ...(configurationIntents ? { configurationOffer, configureIntent } : {}),
        close() { owner.closed = true; unsubscribe?.(); activeOperations.clear(); issuedOperations.clear(); instances.delete(api); } });
    instances.set(api, owner);
    return api;
}
