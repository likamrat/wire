import { readFile, lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { BOARD_ID } from "./evidence.mjs";
import { BoardError, exclusiveBoard, stageEvidenceSnapshot, loadBoardState, resolveDataDir, writeExclusive } from "./store.mjs";
import { createCollector } from "./collector.mjs";
import { atomicJson, readJson, hash, TAIL_LIMITS, contextFits } from "./collector-io.mjs";
import { validateCollectorIndex } from "./collector-index.mjs";
import { safeDeletionFile } from "./deletion-storage.mjs";
import { filterDeletedEvents, filterDeletedRecords } from "./deletion-identities.mjs";
import { promptAuthorship } from "./prompt-authorship.mjs";
import { completeWorkIqCall } from "./history.mjs";
import { assessmentSource } from "./assessment-read-model.mjs";
import { automaticRuns, automaticUsage } from "./automatic-score-store.mjs";
import { planAutomaticScore } from "./automatic-score-policy.mjs";

const sourceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const digest = value => hash(JSON.stringify(value));
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(value);
const instant = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const requireThat = (condition, message) => { if (!condition) throw new BoardError(message, 409); };
const same = (left, right, message) => requireThat(isDeepStrictEqual(left, right), message);
const stateName = `${BOARD_ID}.state.json`;
const checkpointBytes = TAIL_LIMITS.maxContextBytes + TAIL_LIMITS.maxPendingPromptBytes + 64 * 1024;
export const maintenanceMetadata = Object.freeze({ digest, sha, id, instant, requireThat, same, shape });
function shape(value, keys) {
    requireThat(value && Object.getPrototypeOf(value) === Object.prototype
        && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), "Invalid maintenance metadata shape.");
}
function relative(value) {
    requireThat(typeof value === "string" && !path.isAbsolute(value)
        && value.split(/[\\/]/).every(part => part && part !== "." && part !== ".." && !part.includes(":")), "Unsafe maintenance path.");
    return value;
}
function inside(root, file) {
    const value = path.relative(root, file);
    return value === "" || !path.isAbsolute(value) && value !== ".." && !value.startsWith(`..${path.sep}`);
}
async function optional(file, limit = Infinity) {
    try {
        if (Number.isFinite(limit)) requireThat((await lstat(file)).size <= limit, "Maintenance metadata file exceeds its read bound.");
        const bytes = await readFile(file);
        requireThat(bytes.length <= limit, "Maintenance metadata file grew beyond its read bound.");
        return bytes;
    }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function metadataFile(file) {
    requireThat(path.isAbsolute(file), "Maintenance input paths must be absolute.");
    const safe = await safeDeletionFile(path.dirname(file), path.basename(file));
    const info = await lstat(safe);
    requireThat(info.isFile() && info.size <= 2 * 1024 ** 2, "Maintenance metadata input is missing or oversized.");
    const bytes = await readFile(safe);
    requireThat(bytes.length <= 2 * 1024 ** 2, "Maintenance metadata input grew beyond its bound.");
    return { bytes, value: JSON.parse(bytes) };
}

export function maintenanceStateGuard(state) {
    const { revision, evidenceRevision, evidenceFile, continuation, ...preserved } = state;
    return digest(preserved);
}

export function validateMaintenancePlan(plan, { retainedErrors = false } = {}) {
    shape(plan, ["schemaVersion", "operationId", "attestation", "source", "stateGuardSha256", "preservedFiles", "targets",
        ...(retainedErrors ? ["retainedErrorRepair"] : [])]);
    requireThat(plan.schemaVersion === (retainedErrors ? 2 : 1) && /^[a-f0-9-]{36}$/i.test(plan.operationId) && sha(plan.stateGuardSha256), "Invalid maintenance plan identity.");
    shape(plan.attestation, ["packetSha256", "recheckSha256", "stoppedRuntimePid", "recorderIdle", "evaluatorIdle", "noDispatchVerified"]);
    const attestation = plan.attestation;
    requireThat(sha(attestation.packetSha256) && sha(attestation.recheckSha256)
        && Number.isSafeInteger(attestation.stoppedRuntimePid) && attestation.stoppedRuntimePid > 0
        && attestation.recorderIdle === true && attestation.evaluatorIdle === true && attestation.noDispatchVerified === true,
    "Reviewed source predicates and quiescent no-dispatch attestations are required.");
    shape(plan.source, ["configSha256", "indexSha256", "available", "sourceConfigRef", "sourceConfigRevision", "windowDays"]);
    requireThat(sha(plan.source.configSha256) && sha(plan.source.indexSha256) && plan.source.available === true
        && /^sourceconfig-[a-f0-9]{32}$/.test(plan.source.sourceConfigRef)
        && Number.isSafeInteger(plan.source.sourceConfigRevision) && [7, 30, 90].includes(plan.source.windowDays), "Invalid approved source guard.");
    requireThat(Array.isArray(plan.preservedFiles) && plan.preservedFiles.length <= 20000, "Invalid preserved-file inventory.");
    const files = new Set();
    for (const file of plan.preservedFiles) {
        shape(file, ["path", "sha256"]);
        relative(file.path);
        const key = path.normalize(file.path).toLowerCase();
        requireThat(sha(file.sha256) && !files.has(key), "Invalid or duplicate preserved-file guard.");
        files.add(key);
    }
}

function validatePlan(plan) {
    validateMaintenancePlan(plan);
    requireThat(Array.isArray(plan.targets) && plan.targets.length === 2, "Maintenance requires exactly two existing prompts and calls.");
    const scenarios = new Set(), prompts = new Set(), calls = new Set();
    for (const target of plan.targets) {
        shape(target, ["scenarioId", "sourceSessionId", "recordSha256", "prompt", "call"]);
        requireThat(id(target.scenarioId) && /^[a-f0-9-]{36}$/i.test(target.sourceSessionId) && sha(target.recordSha256), "Invalid exact retained target.");
        shape(target.prompt, ["sourceEventId", "sourceTimestamp", "textSha256", "authorship", "authorshipVersion"]);
        shape(target.prompt.authorship, ["actor", "basis"]);
        requireThat(id(target.prompt.sourceEventId) && instant(target.prompt.sourceTimestamp) && sha(target.prompt.textSha256)
            && target.prompt.authorshipVersion === promptAuthorship.version, "Invalid prompt metadata projection.");
        same(promptAuthorship.read({ authorship: target.prompt.authorship }), target.prompt.authorship, "Unsupported prompt author projection.");
        shape(target.call, ["toolCallId", "startEventId", "startedAt", "completionEventId", "completedAt", "failureEvidence"]);
        const call = target.call;
        requireThat([call.toolCallId, call.startEventId, call.completionEventId].every(id)
            && instant(call.startedAt) && instant(call.completedAt)
            && Date.parse(call.startedAt) >= Date.parse(target.prompt.sourceTimestamp)
            && Date.parse(call.completedAt) >= Date.parse(call.startedAt), "Invalid completed-call identity.");
        shape(call.failureEvidence, ["version", "reason", "code", "messageStatus", "messageSignal"]);
        same(completeWorkIqCall({}, { data: { success: false, wireFailureEvidence: call.failureEvidence } }).failureEvidence,
            call.failureEvidence, "Unsupported bounded failure projection.");
        requireThat(call.failureEvidence.version === 1, "A qualified failure projection is required.");
        const promptKey = `${target.sourceSessionId}:${target.prompt.sourceEventId}`, callKey = `${target.sourceSessionId}:${call.toolCallId}`;
        requireThat(!scenarios.has(target.scenarioId) && !prompts.has(promptKey) && !calls.has(callKey), "Duplicate maintenance target.");
        scenarios.add(target.scenarioId); prompts.add(promptKey); calls.add(callKey);
    }
}

async function verifySource(file, expected) {
    requireThat(sha(expected), "A pinned composed source identity is required.");
    const { value: manifest } = await metadataFile(file);
    shape(manifest, ["root", "files", "sourceIdentity"]);
    requireThat(manifest.root === sourceRoot && manifest.sourceIdentity === expected
        && Array.isArray(manifest.files) && manifest.files.length <= 10000 && digest(manifest.files) === expected, "Composed source identity mismatch.");
    const names = new Set();
    for (const entry of manifest.files) {
        shape(entry, ["path", "sha256"]);
        const name = path.normalize(relative(entry.path));
        requireThat(!names.has(name.toLowerCase()) && sha(entry.sha256), "Invalid source manifest entry.");
        names.add(name.toLowerCase());
        requireThat(hash(await readFile(await safeDeletionFile(sourceRoot, name))) === entry.sha256, "Pinned source bytes changed.");
    }
    for (const directory of ["lib", "scripts", "web"]) {
        for (const entry of await readdir(path.join(sourceRoot, directory))) {
            if (entry.endsWith(".mjs")) requireThat(names.has(path.join(directory, entry).toLowerCase()), "Source manifest omits a runtime module.");
        }
    }
}

function stopped(pid) {
    let alive = true;
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === "ESRCH") alive = false; else throw error; }
    requireThat(!alive, "The reviewed runtime PID is still alive or has been reused. Keep normal runtime stopped.");
}
function safeState(state, plan, config, maintenancePolicy, committedPostimage = false) {
    requireThat(state.boardId === BOARD_ID && state.stateVersion === 3 && state.evidenceFile
        && Number.isSafeInteger(state.revision) && state.revision >= 0 && state.revision < Number.MAX_SAFE_INTEGER
        && Number.isSafeInteger(state.evidenceRevision) && state.evidenceRevision >= 0 && state.evidenceRevision < Number.MAX_SAFE_INTEGER,
    "Maintenance requires an existing current board and snapshot.");
    requireThat(!state.deletion?.pending && !state.artifactDeletion?.pending, "Finish sealed deletion cleanup before maintenance.");
    const personal = state.personalEvaluation, data = personal?.modelEvaluation;
    requireThat(!Object.values(personal?.mutations ?? {}).some(mutation => mutation.receipt?.phase === "pending")
        && !data?.automatic?.receipts.some(receipt => receipt.phase === "pending")
        && !data?.runs.some(run => ["queued", "running"].includes(run.phase)), "Evaluation or capture work is pending.");
    requireThat(maintenanceStateGuard(state) === plan.stateGuardSha256, "Preserved lifecycle, cards or ledger metadata changed.");
    const source = assessmentSource(state, config);
    same(source, { available: plan.source.available, sourceConfigRef: plan.source.sourceConfigRef,
        sourceConfigRevision: plan.source.sourceConfigRevision }, "Approved source identity changed.");
    const now = Date.now(), since = Math.max(now - config.windowDays * 86400000, Date.parse(state.importCoverage?.since));
    const until = Math.min(now, Date.parse(state.importCoverage?.until));
    requireThat(Number.isFinite(since) && Number.isFinite(until), "The approved collection window is unavailable.");
    if (!committedPostimage) {
        const outside = plan.targets.filter(target => {
            const window = maintenancePolicy.targetWindow?.(target);
            if (window) {
                requireThat(instant(window.from) && instant(window.to) && Date.parse(window.from) <= Date.parse(window.to), "Invalid maintenance target time boundary.");
                return Date.parse(window.from) < since || Date.parse(window.to) > until;
            }
            return (target.aliases ?? [target]).some(alias =>
                Date.parse(alias.prompt.sourceTimestamp) < since || Date.parse(target.call.completedAt) > until);
        });
        if (outside.length) requireThat(maintenancePolicy.authorizeRetainedWindow?.(plan, outside, { since, until }) === true,
            "Selected evidence is outside the approved collection window.");
        else if (maintenancePolicy.authorizeRetainedWindow) maintenancePolicy.authorizeRetainedWindow(plan, [], { since, until });
    }
    const approval = data?.automatic?.approval ?? null;
    const policy = planAutomaticScore({
        approval, source: { ...source, windowDays: config.windowDays, collectionEnabled: config.enabled },
        candidates: [], attempts: approval ? automaticRuns(data, approval).map(run => ({ attemptKey: run.automatic.attemptKey, phase: run.phase })) : [],
        usage: automaticUsage(data, approval), now: new Date().toISOString(),
    });
    // Empty candidates alone do not prove safety: require a gate that runs before candidate selection.
    requireThat(["not-approved", "revoked", "source-changed", "method-changed", "collection-paused", "unknown-billing",
        "allowance-used", "unresolved-attempt", "evaluation-failed", "session-credit-minimum"].includes(policy.reason),
    "Automatic scoring has no durable no-dispatch guard.");
    return policy.reason;
}

export function inspectMaintenanceState(state, plan, config, policy) {
    return safeState(state, plan, config, policy);
}

function projectRecords(records, plan) {
    for (const target of plan.targets) {
        requireThat(records.filter(record => record.scenarioId === target.scenarioId).length === 1
            && records.filter(record => record.sourceSessionId === target.sourceSessionId && record.userPrompt?.sourceEventId === target.prompt.sourceEventId).length === 1
            && records.flatMap(record => record.sourceSessionId === target.sourceSessionId ? record.toolCalls ?? [] : [])
                .filter(call => call.toolCallId === target.call.toolCallId || call.startEventId === target.call.startEventId
                    || call.completionEventId === target.call.completionEventId).length === 1, "Retained targets are missing or ambiguous.");
    }
    return records.map(record => {
        const target = plan.targets.find(value => value.scenarioId === record.scenarioId);
        if (!target) return record;
        const prompt = record.userPrompt;
        requireThat(digest(record) === target.recordSha256 && record.sourceSessionId === target.sourceSessionId, "Exact retained record preimage changed.");
        requireThat(prompt?.status === "full" && prompt.sourceEventId === target.prompt.sourceEventId && prompt.sourceTimestamp === target.prompt.sourceTimestamp
            && typeof prompt.text === "string" && hash(prompt.text) === target.prompt.textSha256, "Prompt identity, time or retained text changed.");
        checkAuthor(prompt.authorship, prompt.authorshipVersion, target.prompt);
        return { ...record, userPrompt: { ...prompt, authorship: target.prompt.authorship, authorshipVersion: target.prompt.authorshipVersion },
            toolCalls: record.toolCalls.map(call => {
                if (call.toolCallId !== target.call.toolCallId) return call;
                for (const key of ["startEventId", "startedAt", "completionEventId", "completedAt"]) same(call[key], target.call[key], "Call identity or timing changed.");
                requireThat(call.toolSucceeded === false, "The selected call is not a recorded failure.");
                checkFailure(call.failureEvidence, target.call.failureEvidence);
                return { ...call, failureEvidence: target.call.failureEvidence };
            }) };
    });
}
function checkAuthor(authorship, version, proposal) {
    const current = promptAuthorship.read({ authorship });
    requireThat(version === undefined || Number.isInteger(version) && version <= promptAuthorship.version, "A newer author classifier is already present.");
    if (current.actor !== "unknown" || ["system-source", "conflicting-source"].includes(current.basis)) {
        same(current, proposal.authorship, "Conflicting stronger author evidence is already present.");
    }
}
function checkFailure(current, proposal) {
    if (current != null) same(current, proposal, "Conflicting failure evidence is already present.");
}
function projectCheckpoint(checkpoint, source, plan, state, index) {
    requireThat(checkpoint.schemaVersion === 1 && Array.isArray(checkpoint.events), "Invalid retained checkpoint.");
    same(checkpoint.cursor, index.sources[source]?.cursor, "Checkpoint cursor and approved index disagree.");
    const targets = plan.targets.filter(target => target.sourceSessionId === source);
    const seen = new Set(), next = structuredClone(checkpoint);
    for (const event of next.events) {
        const prompt = targets.find(target => target.prompt.sourceEventId === event.id)?.prompt;
        const call = targets.find(target => target.call.completionEventId === event.id
            || event.type === "tool.execution_complete" && target.call.toolCallId === event.data?.toolCallId)?.call;
        if (!prompt && !call) continue;
        requireThat(!seen.has(event.id), "Duplicate retained target event.");
        seen.add(event.id);
        if (prompt) {
            requireThat(event.type === "user.message" && event.timestamp === prompt.sourceTimestamp
                && typeof event.data?.content === "string" && hash(event.data.content) === prompt.textSha256, "Retained prompt checkpoint identity changed.");
            checkAuthor(event.data.wirePromptAuthorship, event.data.wirePromptAuthorshipVersion, prompt);
            event.data.wirePromptAuthorship = prompt.authorship;
            event.data.wirePromptAuthorshipVersion = prompt.authorshipVersion;
        }
        if (call) {
            requireThat(event.id === call.completionEventId && event.type === "tool.execution_complete" && event.timestamp === call.completedAt
                && event.data?.toolCallId === call.toolCallId && event.data.success === false, "Retained completion checkpoint identity changed.");
            checkFailure(event.data.wireFailureEvidence, call.failureEvidence);
            event.data.wireFailureEvidence = call.failureEvidence;
        }
    }
    requireThat(contextFits(next.events),
        "Metadata postimage exceeds existing checkpoint bounds; no context was evicted.");
    same(filterDeletedEvents(next.events, source, state.deletion), next.events, "Deletion filtering would change retained checkpoint membership.");
    return next;
}

async function readStore(dir) {
    const bytes = await readFile(await safeDeletionFile(dir, stateName)), state = JSON.parse(bytes);
    requireThat(state.boardId === BOARD_ID && state.stateVersion === 3 && /^[a-f0-9]{64}\.json$/.test(state.evidenceFile), "Existing board identity or snapshot pointer is invalid.");
    const snapshotBytes = await readFile(await safeDeletionFile(dir, path.join("private-evidence", state.evidenceFile)));
    requireThat(hash(snapshotBytes) + ".json" === state.evidenceFile, "Private snapshot integrity check failed.");
    const snapshot = JSON.parse(snapshotBytes);
    requireThat(Array.isArray(snapshot.records), "Invalid existing snapshot.");
    return { bytes, state, snapshot };
}

// Explicit offline entry only: no server, collector cycle, original-history reader or evaluator is started.
export function runHistoricalMaintenance(options, hooks) {
    return runMetadataMaintenance(options, { validatePlan, projectRecords, projectCheckpoint }, hooks);
}

// Projection policies are source-owned, never supplied by a plan or an HTTP request.
export async function runMetadataMaintenance(options, policy, { onStep = async () => {} } = {}) {
    const { mode, dataDir, planFile, planSha256, journalFile, reviewSha256, sourceManifestFile, sourceIdentity } = options;
    requireThat(["prepare", "apply"].includes(mode) && sha(planSha256) && typeof dataDir === "string" && path.isAbsolute(dataDir)
        && [planFile, journalFile, sourceManifestFile].every(file => typeof file === "string" && path.isAbsolute(file)),
        "Explicit maintenance mode, data directory and sealed plan hash are required.");
    const session = { dataDir: resolveDataDir({ dataDir }) }, dir = session.dataDir;
    requireThat(path.isAbsolute(journalFile) && !inside(sourceRoot, journalFile) && !inside(dir, journalFile),
        "The private maintenance journal must be outside source and collection storage.");
    await safeDeletionFile(path.dirname(journalFile), path.basename(journalFile));
    const { bytes: planBytes, value: plan } = await metadataFile(planFile);
    requireThat(hash(planBytes) === planSha256, "Sealed plan bytes changed.");
    policy.validatePlan(plan);
    await verifySource(sourceManifestFile, sourceIdentity);
    stopped(plan.attestation.stoppedRuntimePid);
    const journalBytes = await optional(journalFile, 2 * 1024 ** 2);
    let core;
    if (mode === "prepare") requireThat(journalBytes === null, "An existing maintenance journal cannot be replaced.");
    else {
        requireThat(journalBytes && sha(reviewSha256), "Apply requires the reviewed preparation journal and its seal.");
        core = JSON.parse(journalBytes).core;
        requireThat(core && digest(core) === reviewSha256 && core.planSha256 === planSha256 && core.sourceIdentity === sourceIdentity
            && core.dataDirSha256 === hash(dir) && core.operationId === plan.operationId, "Reviewed maintenance journal mismatch.");
    }
    await readStore(dir); // Fail before helpers that could initialize a missing board.
    requireThat((await lstat(await safeDeletionFile(dir, "exports"))).isDirectory(), "Existing export storage is required.");
    const initialIndex = await readJson(await safeDeletionFile(dir, path.join("collector", "index.json")));
    requireThat(!initialIndex?.completionReferenceMaintenance || mode === "apply" && core?.index,
        "Resume the existing sealed reference maintenance; do not prepare a replacement operation.");
    const collector = await createCollector(session, { timers: false,
        ...(core?.index ? { maintenanceOperation: { operationId: plan.operationId, planSha256 } } : {}) });
    try {
        const result = await collector.exclusiveActivity(() => exclusiveBoard(session, async (state, save) => {
            const store = await readStore(dir);
            same(JSON.parse(JSON.stringify(state)), store.state, "Board loading would migrate or filter existing state.");
            const configFile = await safeDeletionFile(dir, path.join("collector", "config.json"));
            const indexFile = await safeDeletionFile(dir, path.join("collector", "index.json"));
            const configBytes = await readFile(configFile), indexBytes = await readFile(indexFile);
            const indexHash = hash(indexBytes);
            requireThat(hash(configBytes) === plan.source.configSha256
                && [plan.source.indexSha256, ...(core?.index ? [core.index.pendingSha256, core.index.afterSha256] : [])].includes(indexHash),
            "Source configuration or index changed.");
            const config = JSON.parse(configBytes), index = validateCollectorIndex(JSON.parse(indexBytes));
            same(collector.approvedRecollectionSource(), config, "Collector configuration changed.");
            requireThat(config.windowDays === plan.source.windowDays
                && index.fingerprint === digest([config.appDbPath, config.sessionRoot, config.windowDays]), "Approved checkpoint fingerprint changed.");
            const sealedCompletion = Boolean(core?.index) && policy.finishSealedPostimage === true && hash(store.bytes) === core.state.afterSha256;
            const noDispatchReason = safeState(state, plan, config, policy, sealedCompletion);
            if (policy.validateState && !sealedCompletion) await policy.validateState(state, plan, config, store.snapshot.records, index,
                { allowPostimage: Boolean(core) && hash(store.bytes) === core.state.afterSha256 });
            const finalIndex = policy.projectIndex ? validateCollectorIndex(policy.projectIndex(index, plan, state)) : index;
            const indexTransition = policy.projectIndex ? {
                final: finalIndex, pending: { ...finalIndex, completionReferenceMaintenance: { operationId: plan.operationId, planSha256 } },
            } : null;
            if (indexTransition) {
                const invariant = value => {
                    const { schemaVersion, completionReferenceVersion, completionReferenceStore,
                        completionReferenceSources, completionReferenceMaintenance, ...unchanged } = value;
                    return unchanged;
                };
                same(invariant(index), invariant(finalIndex), "Reference fencing cannot change collector progress or source ownership.");
                requireThat(finalIndex.schemaVersion === 4 && !finalIndex.completionReferenceMaintenance
                    && (index.completionReferenceSources ?? []).every(source =>
                        finalIndex.completionReferenceSources.some(next => isDeepStrictEqual(next, source))),
                "Reference fencing cannot withdraw existing source bindings.");
                requireThat(!plan.preservedFiles.some(file => path.normalize(file.path) === path.join("collector", "index.json")),
                    "The explicitly transitioned index cannot also be declared byte-preserved.");
                validateCollectorIndex(indexTransition.pending);
            }
            const allowedIndexHashes = () => indexTransition
                ? [plan.source.indexSha256, digest(indexTransition.pending), digest(indexTransition.final)]
                : [plan.source.indexSha256];
            const verifyPreserved = async () => {
                for (const file of plan.preservedFiles) requireThat(hash(await readFile(await safeDeletionFile(dir, file.path))) === file.sha256, "Preserved artifact or host receipt changed.");
                for (const entry of state.exports) for (const file of Object.values(entry.files ?? {})) {
                    requireThat(typeof file === "string" && inside(dir, file)
                        && plan.preservedFiles.some(pin => path.join(dir, pin.path) === file), "Every saved bundle file must have a preservation guard.");
                }
                requireThat(hash(await readFile(configFile)) === plan.source.configSha256 && allowedIndexHashes().includes(hash(await readFile(indexFile))),
                    "Source configuration or index changed during maintenance.");
            };
            await verifyPreserved();
            let boardComplete = false;
            if (core) {
                const currentHash = hash(store.bytes);
                requireThat([core.state.beforeSha256, core.state.afterSha256].includes(currentHash), "Board pre/postimage drift; keep runtime stopped.");
                boardComplete = currentHash === core.state.afterSha256;
                if (core.index) {
                    requireThat(indexTransition && core.index.beforeSha256 === plan.source.indexSha256
                        && core.index.pendingSha256 === digest(indexTransition.pending) && core.index.afterSha256 === digest(indexTransition.final),
                    "Reference fence no longer matches its sealed transition.");
                    requireThat(indexHash !== core.index.afterSha256 || indexHash === core.index.beforeSha256 || boardComplete,
                        "Reference fence was released before the board postimage.");
                }
            }
            const records = boardComplete ? store.snapshot.records : policy.projectRecords(store.snapshot.records, plan);
            same(filterDeletedRecords(records, state.deletion), records, "Deletion filtering would change evidence membership.");
            const built = { ...store.snapshot, records };
            const snapshotHash = digest(built), afterState = { ...state, evidenceFile: `${snapshotHash}.json`,
                revision: state.revision + Number(!boardComplete), evidenceRevision: state.evidenceRevision + Number(!boardComplete) };
            if (!boardComplete) requireThat(snapshotHash + ".json" !== state.evidenceFile, "The approved projection makes no evidence change.");
            const existingSnapshot = await optional(await safeDeletionFile(dir, path.join("private-evidence", afterState.evidenceFile)));
            requireThat(existingSnapshot === null || hash(existingSnapshot) === snapshotHash, "Proposed snapshot path has conflicting content.");
            const checkpoints = [];
            for (const source of [...new Set(plan.targets.map(target => target.sourceSessionId))].sort()) {
                requireThat(index.sources?.[source], "Selected source is absent from the approved index.");
                const file = await safeDeletionFile(dir, path.join("collector", index.fingerprint, `${source}.json`));
                const bytes = await optional(file, checkpointBytes), beforeHash = bytes === null ? null : hash(bytes);
                const sealed = core?.checkpoints.find(entry => entry.sourceSessionId === source);
                if (core) requireThat(sealed && [sealed.beforeSha256, sealed.afterSha256].includes(beforeHash), "Checkpoint pre/postimage drift; keep runtime stopped.");
                if (boardComplete) requireThat(beforeHash === sealed.afterSha256, "Committed board has an incomplete checkpoint postimage.");
                const current = bytes === null ? null : JSON.parse(bytes);
                const post = current === null || sealedCompletion ? current : policy.projectCheckpoint(current, source, plan, state, finalIndex,
                    { allowPostimage: Boolean(core) && beforeHash === sealed.afterSha256 });
                const afterHash = isDeepStrictEqual(post, current) ? beforeHash : digest(post);
                if (core) requireThat(afterHash === sealed.afterSha256, "Checkpoint postimage no longer matches the reviewed projection.");
                checkpoints.push({ file, post, beforeHash, afterHash, sourceSessionId: source });
            }
            if (mode === "prepare") {
                await policy.verifyInputs?.();
                core = {
                    schemaVersion: 1, operationId: plan.operationId, planSha256, sourceIdentity, dataDirSha256: hash(dir), noDispatchReason,
                    state: { beforeSha256: hash(store.bytes), afterSha256: hash(JSON.stringify(afterState, null, 2)),
                        beforeRevision: state.revision, afterRevision: afterState.revision },
                    snapshot: { beforeFile: state.evidenceFile, afterFile: afterState.evidenceFile },
                    checkpoints: checkpoints.map(entry => ({ sourceSessionId: entry.sourceSessionId, beforeSha256: entry.beforeHash, afterSha256: entry.afterHash })),
                    ...(indexTransition ? { index: { beforeSha256: plan.source.indexSha256,
                        pendingSha256: digest(indexTransition.pending), afterSha256: digest(indexTransition.final) } } : {}),
                };
                await writeExclusive(journalFile, JSON.stringify({ core, phase: "prepared" }));
                return { status: "prepared", reviewSha256: digest(core), noDispatchReason };
            }
            requireThat(afterState.evidenceFile === core.snapshot.afterFile && hash(JSON.stringify(afterState, null, 2)) === core.state.afterSha256,
                "Board postimage no longer matches the reviewed projection.");
            const step = async phase => {
                await onStep(phase);
                await atomicJson(journalFile, { core, phase });
            };
            // Each file is atomic, not the operation. The sealed hashes recognize completed writes after interruption.
            await step("applying");
            if (!sealedCompletion) await policy.verifyInputs?.();
            if (indexTransition && indexHash === core.index.beforeSha256 && !boardComplete) {
                await atomicJson(indexFile, indexTransition.pending);
                await step("compatibility-fence");
            }
            for (const [index, entry] of checkpoints.entries()) if (entry.beforeHash !== entry.afterHash) {
                await atomicJson(entry.file, entry.post);
                await step(`checkpoint-${index + 1}`);
            }
            if (!boardComplete) {
                await stageEvidenceSnapshot(session, state, built);
                state.continuation = store.state.continuation;
                state.revision++;
                requireThat(hash(JSON.stringify(state, null, 2)) === core.state.afterSha256, "Staged state does not match its sealed postimage.");
                const staged = await readFile(await safeDeletionFile(dir, path.join("private-evidence", state.evidenceFile)));
                requireThat(hash(staged) + ".json" === core.snapshot.afterFile, "Staged snapshot integrity check failed.");
                await step("snapshot-staged");
                requireThat(hash(await readFile(await safeDeletionFile(dir, stateName))) === core.state.beforeSha256, "Board changed before publication.");
                await policy.verifyInputs?.();
                await save(state);
                await step("board-saved");
            }
            const committed = await readStore(dir);
            requireThat(hash(committed.bytes) === core.state.afterSha256, "Committed board postimage is unconfirmed; keep runtime stopped.");
            for (const entry of checkpoints) {
                const bytes = await optional(entry.file, checkpointBytes);
                requireThat((bytes === null ? null : hash(bytes)) === entry.afterHash, "Committed checkpoint postimage is unconfirmed.");
            }
            await verifyPreserved();
            await step("complete");
            if (indexTransition) {
                requireThat([core.index.pendingSha256, core.index.afterSha256].includes(hash(await readFile(indexFile))),
                    "Reference fence changed before release; keep the runtime stopped.");
                if (hash(await readFile(indexFile)) !== core.index.afterSha256) await atomicJson(indexFile, indexTransition.final);
                requireThat(hash(await readFile(indexFile)) === core.index.afterSha256, "Reference fence release is unconfirmed; resume the same journal.");
            }
            return { status: "complete", reviewSha256, revision: core.state.afterRevision, evidenceFile: core.snapshot.afterFile,
                alreadyCommitted: boardComplete, noDispatchReason };
        }));
        if (mode === "apply") {
            const committed = await loadBoardState(session);
            requireThat(committed.revision === result.revision && committed.evidenceFile === result.evidenceFile,
                "Normal board loading did not confirm the committed postimage.");
        }
        return result;
    } finally {
        await collector.close();
    }
}
