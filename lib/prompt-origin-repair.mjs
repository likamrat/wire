import { open, readFile, stat } from "node:fs/promises";
import { createHmac } from "node:crypto";
import path from "node:path";
import { promptAuthorship } from "./prompt-authorship.mjs";
import { hash, contextFits, readTail, sourceFileStamp, TAIL_LIMITS } from "./collector-io.mjs";
import { sourceHost, bindSourceHost, sourceFingerprint } from "./source-host.mjs";
import { hostPaths } from "./host-paths.mjs";
import { safeDeletionFile } from "./deletion-storage.mjs";
import { filterDeletedEvents } from "./deletion-identities.mjs";
import { runMetadataMaintenance, validateMaintenancePlan, maintenanceMetadata, maintenanceStateGuard, inspectMaintenanceState } from "./historical-maintenance.mjs";
import { loadBoardState, mergeEvidenceWithState, resolveDataDir } from "./store.mjs";
import { buildActivitySelection, projectPromptOrigins } from "./activity-analytics.mjs";
import { createPercentageCharts } from "./percentage-charts.mjs";
import { validateCollectorIndex } from "./collector-index.mjs";
import { assessmentSource } from "./assessment-read-model.mjs";
import { BOARD_ID } from "./evidence.mjs";
import { completionReferenceStore, validateReferenceCheckpoint } from "./checkpoint-references.mjs";
import { readSourceMetadata, sourceMetadataStamp } from "./source-reader.mjs";

const { digest, sha, id, instant, requireThat, same, shape } = maintenanceMetadata;
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const originKey = (source, event) => JSON.stringify([source, event]);
const supportedOrigins = new Set(["source-user", "source-agent", "autopilot", "host-agent-authored", "host-direct-input", "host-agent-envelope"]);
// Qualification, pre-effect and pre-publication; inspection uses derivation as its first pass.
const originalReadBudget = pin => 3 * (2 * pin.bytes + pin.startupBytes + 1);
const sourceBinding = row => ({
    adapter: row.adapter, sessionId: row.sessionId, appId: row.appId, projectId: row.projectId, projectType: row.projectType,
    workspaceIds: row.workspaceIds, activeWorkspaceIds: row.activeWorkspaceIds, archiveEvidence: row.archiveEvidence,
    archivedAt: row.archivedAt, eligible: row.eligible, disposition: row.disposition,
    localSourceVerified: row.localSourceVerified ?? null, promptCreation: row.promptCreation,
});
function compatibleSourceBinding(row) {
    // Retained coverage replaces discovery disposition with its collection outcome.
    const { localSourceVerified, disposition, ...binding } = sourceBinding(row);
    return binding;
}
function selectedMetadataProof(metadata, row) {
    requireThat(sha(metadata.sourceIdentity), "The selected author review database identity is unavailable.");
    const { checkedAt, ...mapping } = row;
    return digest([metadata.adapter, metadata.schemaVersion, metadata.sourceIdentity, mapping]);
}
function verifyTargetMapping(metadata, target) {
    const row = sourceForTarget(metadata.roster, target);
    if (target.sourceMapping?.metadataSha256) same(selectedMetadataProof(metadata, row), target.sourceMapping.metadataSha256,
        "The reviewed author database or selected chat mapping changed.");
    return row;
}
function sourceForTarget(roster, target) {
    const rows = roster.filter(row => row.sessionId === target.sourceSessionId);
    requireThat(rows.length === 1, "The exact source mapping is unavailable or ambiguous.");
    const row = rows[0], mapping = target.sourceMapping;
    requireThat(mapping?.archived ? !row.eligible && row.disposition === "archived" && row.localSourceVerified === true : row.eligible,
        "The reviewed local source disposition changed.");
    if (mapping) same(digest(sourceBinding(row)), mapping.sha256, "The reviewed source mapping changed.");
    return row;
}

function validatePin(pin) {
    shape(pin, ["sourceIdentity", "offset", "bytes", "sha256", "startupBytes", "startupSha256",
        ...(Object.hasOwn(pin, "sourceStampSha256") ? ["sourceStampSha256"] : [])]);
    requireThat(typeof pin.sourceIdentity === "string" && pin.sourceIdentity.length <= 512
        && Number.isSafeInteger(pin.startupBytes) && pin.startupBytes > 0 && pin.startupBytes <= 65536
        && Number.isSafeInteger(pin.offset) && pin.offset >= pin.startupBytes
        && Number.isSafeInteger(pin.bytes) && pin.bytes > 0 && pin.bytes <= TAIL_LIMITS.maxLineBytes
        && Number.isSafeInteger(pin.offset + pin.bytes) && sha(pin.sha256) && sha(pin.startupSha256)
        && (!Object.hasOwn(pin, "sourceStampSha256") || sha(pin.sourceStampSha256)),
    "Prompt restoration requires exact bounded original regions.");
}

function validateOrigins(origins) {
    requireThat(Array.isArray(origins) && origins.length > 0 && origins.length <= 32, "Review one to 32 exact retained origins.");
    const seen = new Set();
    let bytes = 0;
    for (const origin of origins) {
        shape(origin, ["sourceSessionId", "sourceEventId", "sourceEvent", "olderRetained",
            ...(Object.hasOwn(origin, "includeArchived") ? ["includeArchived"] : [])]);
        requireThat(uuid(origin.sourceSessionId) && id(origin.sourceEventId) && typeof origin.olderRetained === "boolean"
            && (!Object.hasOwn(origin, "includeArchived") || origin.includeArchived === true), "Invalid exact origin selector.");
        const key = originKey(origin.sourceSessionId, origin.sourceEventId);
        requireThat(!seen.has(key), "Duplicate origin selector."); seen.add(key);
        validatePin(origin.sourceEvent);
        bytes += originalReadBudget(origin.sourceEvent);
    }
    requireThat(bytes <= TAIL_LIMITS.cycleBytes, "The selected original reads exceed the existing cycle budget.");
}

function validateTargets(targets) {
    requireThat(Array.isArray(targets) && targets.length > 0 && targets.length <= 32, "Seal one to 32 exact prompt origins within the existing read budget.");
    const seen = new Set();
    let bytes = 0;
    for (const target of targets) {
        shape(target, ["sourceSessionId", "prompt", "sourceEvent", "kickoff", "aliases", "checkpointContextSha256", "olderRetained",
            ...(Object.hasOwn(target, "checkpointOnly") ? ["checkpointOnly"] : []),
            ...(Object.hasOwn(target, "sourceMapping") ? ["sourceMapping"] : []),
            ...(Object.hasOwn(target, "legacyUnqualified") ? ["legacyUnqualified"] : [])]);
        if (Object.hasOwn(target, "legacyUnqualified")) requireThat(target.legacyUnqualified === true, "Invalid legacy-origin exception.");
        if (Object.hasOwn(target, "sourceMapping")) {
            const bound = Object.hasOwn(target.sourceMapping, "metadataSha256");
            shape(target.sourceMapping, ["archived", "sha256", ...(bound ? ["metadataSha256"] : [])]);
            requireThat(typeof target.sourceMapping.archived === "boolean" && sha(target.sourceMapping.sha256)
                && (!bound || sha(target.sourceMapping.metadataSha256)), "Invalid exact source mapping guard.");
        }
        requireThat(uuid(target.sourceSessionId) && sha(target.checkpointContextSha256) && typeof target.olderRetained === "boolean",
            "Invalid prompt restoration source.");
        shape(target.prompt, ["sourceEventId", "sourceTimestamp", "textSha256", "authorship", "authorshipVersion"]);
        requireThat(id(target.prompt.sourceEventId) && instant(target.prompt.sourceTimestamp) && sha(target.prompt.textSha256)
            && target.prompt.authorshipVersion === promptAuthorship.version, "Invalid restored prompt identity.");
        same(promptAuthorship.read({ authorship: target.prompt.authorship }), target.prompt.authorship, "Invalid proposed prompt origin.");
        requireThat(supportedOrigins.has(target.prompt.authorship.basis)
            && target.prompt.authorship.actor !== "unknown", "Restore only independently qualified host origins.");
        requireThat(target.sourceMapping || !target.legacyUnqualified
            && ["host-direct-input", "host-agent-envelope"].includes(target.prompt.authorship.basis),
        "Explicit-source and legacy origin corrections require a fresh source mapping guard.");
        const key = originKey(target.sourceSessionId, target.prompt.sourceEventId);
        requireThat(!seen.has(key), "Duplicate restoration origin."); seen.add(key);
        validatePin(target.sourceEvent);
        requireThat(target.kickoff === null, "This repair qualifies the original host envelope without a creator-history lookup.");
        bytes += originalReadBudget(target.sourceEvent);
        requireThat(Array.isArray(target.aliases) && target.aliases.length <= 8
            && (target.aliases.length ? !Object.hasOwn(target, "checkpointOnly") : target.checkpointOnly === true),
            "Seal every retained origin and follow-up copy.");
        const aliases = new Set();
        for (const alias of target.aliases) {
            shape(alias, ["scenarioId", "recordSha256", "field", "index"]);
            requireThat(id(alias.scenarioId) && sha(alias.recordSha256)
                && (alias.field === "origin" ? alias.index === null
                    : alias.field === "followup" && Number.isSafeInteger(alias.index) && alias.index >= 0),
            "Invalid retained prompt-copy binding.");
            const key = JSON.stringify([alias.scenarioId, alias.field, alias.index]);
            requireThat(!aliases.has(key), "Duplicate retained prompt copy."); aliases.add(key);
        }
    }
    requireThat(bytes <= TAIL_LIMITS.cycleBytes, "The sealed prompt reads exceed the existing cycle budget.");
}

function occurrences(records, target) {
    return records.filter(record => record.sourceSessionId === target.sourceSessionId).flatMap(record => [
        { record, prompt: record.userPrompt, field: "origin", index: null },
        ...(record.followUpPrompts ?? []).map((prompt, index) => ({ record, prompt, field: "followup", index })),
    ]).filter(row => row.prompt?.sourceEventId === target.prompt.sourceEventId);
}

function retainedCreatorEvidence(state, metadata, index, child, original) {
    const source = index.sources[child.sessionId];
    if (!child.eligible || child.promptCreation?.actor !== "agent") return { status: "creator-not-qualified" };
    if (!source?.promptStartObserved || source.firstPromptEventId !== original.id) return { status: "first-original-not-qualified" };
    const id = child.promptCreation.creatorSessionId;
    const creators = metadata.roster.filter(row => row.eligible && [row.sessionId, row.appId, ...row.workspaceIds].includes(id));
    if (creators.length !== 1) return { status: "creator-mapping-not-unique" };
    const [creator] = creators, cursor = index.sources[creator.sessionId]?.cursor;
    const promptHash = createHmac("sha256", state.pseudonymKey).update(original.data.content).digest("hex");
    const candidates = (index.promptOrigins ?? []).filter(origin => origin.creatorSessionId === creator.sessionId
        && origin.promptHash === promptHash && Number.isFinite(Date.parse(origin.timestamp))
        && Date.parse(origin.timestamp) <= Date.parse(original.timestamp));
    const receipt = source.promptQualification;
    const childBound = receipt?.status === "qualified" && receipt.eventId === original.id && receipt.creatorSessionId === creator.sessionId
        && typeof cursor?.identity === "string" && receipt.creatorIdentity === cursor.identity;
    return { status: candidates.length > 1 ? "competing-retained-kickoffs" : !candidates.length ? "no-retained-kickoff-match"
        : childBound && receipt.creatorEventId === candidates[0].eventId ? "exact-child-and-creator-receipts"
            : "retained-kickoff-without-child-receipt" };
}

async function readOriginal(config, index, sourceId, pin) {
    const source = index.sources?.[sourceId], cursor = source?.cursor;
    requireThat(source?.scanned && !source.error && cursor?.identity === pin.sourceIdentity
        && cursor.offset >= pin.offset + pin.bytes && cursor.partialBytes === 0 && cursor.backlogBytes === 0,
    "The sealed prompt source is unavailable or not fully consumed.");
    const access = sourceHost(config), file = access.historyFile(sourceId);
    const handle = await open(await safeDeletionFile(access.historyRoot(), path.join(sourceId, "events.jsonl")), "r");
    try {
        const before = await handle.stat();
        requireThat(before.isFile() && before.nlink === 1 && cursor.offset <= before.size, "Original prompt source is linked or incomplete.");
        if (pin.sourceStampSha256) requireThat(before.size === cursor.offset && pin.sourceStampSha256 === hash(sourceFileStamp(before)),
            "The source changed since the complete historical author review.");
        async function region(offset, length, expected) {
            const bytes = Buffer.alloc(length);
            let read = 0;
            while (read < length) {
                const next = await handle.read(bytes, read, length - read, offset + read);
                requireThat(next.bytesRead > 0, "Original prompt region became incomplete.");
                read += next.bytesRead;
            }
            requireThat(hash(bytes) === expected && bytes.at(-1) === 10 && bytes.indexOf(10) === bytes.length - 1,
                "Original prompt region changed or is not one JSONL entry.");
            return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        }
        const startup = await region(0, pin.startupBytes, pin.startupSha256);
        requireThat(startup.type === "session.start" && startup.data?.sessionId === sourceId && startup.data.version === 1,
            "Original prompt source startup changed.");
        const identity = `${before.dev}:${before.ino}:${before.birthtimeMs}:${startup.id}`;
        requireThat(identity === pin.sourceIdentity || hostPaths.windowsSource(file)
            && /^\d+:/.test(pin.sourceIdentity)
            && pin.sourceIdentity.slice(pin.sourceIdentity.indexOf(":") + 1) === `${before.ino}:${before.birthtimeMs}:${startup.id}`,
        "Original prompt source generation changed.");
        const boundary = Buffer.alloc(1);
        requireThat((await handle.read(boundary, 0, 1, pin.offset - 1)).bytesRead === 1 && boundary[0] === 10,
            "Original prompt does not begin at a JSONL boundary.");
        const event = await region(pin.offset, pin.bytes, pin.sha256);
        await region(pin.offset, pin.bytes, pin.sha256);
        requireThat(sourceFileStamp(before) === sourceFileStamp(await handle.stat())
            && (!pin.sourceStampSha256 || pin.sourceStampSha256 === hash(sourceFileStamp(await stat(file)))),
        "Original prompt source changed during validation.");
        return event;
    } finally { await handle.close(); }
}

function verifyPrompt(prompt, target, allowPostimage) {
    requireThat(prompt?.sourceTimestamp === target.prompt.sourceTimestamp && typeof prompt.text === "string"
        && hash(prompt.text) === target.prompt.textSha256 && !prompt.capture?.conflict,
    "Retained prompt text, time or conflict state changed.");
    const author = promptAuthorship.read(prompt);
    if (allowPostimage && prompt.authorshipVersion === target.prompt.authorshipVersion) {
        same(author, target.prompt.authorship, "Restored prompt postimage differs."); return;
    }
    requireThat(reviewableAuthor(prompt, target.legacyUnqualified), "The prompt is not the reviewed older unqualified origin.");
}

function reviewableAuthor(prompt, allowLegacy) {
    const author = promptAuthorship.read(prompt);
    return author.actor === "unknown" && (allowLegacy && prompt.authorship === undefined && prompt.authorshipVersion === undefined
        || ["missing-source", "invalid-source", "unsupported-source", "conflicting-source"].includes(author.basis)
        && Number.isSafeInteger(prompt.authorshipVersion) && prompt.authorshipVersion > 0 && prompt.authorshipVersion < promptAuthorship.version);
}

export function createPromptOriginRepairPolicy(dataDir) {
    return originPolicy(dataDir);
}
function originPolicy(dataDir, readMetadata = files => readSourceMetadata(files, { includeIdentity: true })) {
    const projected = new Set();
    let metadata, metadataFiles, mappedTargets, originalInputs;
    async function verifyMappings() {
        if (!mappedTargets?.length) return;
        if (!metadata || sourceMetadataStamp(metadataFiles) !== metadata.metadataStamp) metadata = await readMetadata(metadataFiles);
        for (const target of mappedTargets) verifyTargetMapping(metadata, target);
    }
    async function verifyInputs() {
        await verifyMappings();
        if (!originalInputs) return;
        for (const target of originalInputs.targets) {
            await readOriginal(originalInputs.config, originalInputs.index, target.sourceSessionId, target.sourceEvent);
        }
    }
    return {
        finishSealedPostimage: true,
        verifyInputs,
        validatePlan(plan) {
            validateMaintenancePlan(plan); validateTargets(plan.targets);
            requireThat(plan.targets.some(target => target.aliases.length), "Checkpoint-only corrections must accompany a sealed retained-origin repair.");
        },
        targetWindow(target) { return { from: target.prompt.sourceTimestamp, to: target.prompt.sourceTimestamp }; },
        authorizeRetainedWindow(plan, outside, { until }) {
            same(outside.map(target => originKey(target.sourceSessionId, target.prompt.sourceEventId)).sort(),
                plan.targets.filter(target => target.olderRetained).map(target => originKey(target.sourceSessionId, target.prompt.sourceEventId)).sort(),
            "The named retained-origin window exception changed.");
            requireThat(outside.every(target => Date.parse(target.prompt.sourceTimestamp) <= until),
                "Prompt restoration cannot admit future source activity.");
            return true;
        },
        projectIndex(index, plan, state) {
            requireThat([3, 4].includes(index.schemaVersion), "Prompt restoration requires an existing host-owned collector.");
            const store = completionReferenceStore(state, dataDir);
            requireThat(index.schemaVersion !== 4 || index.completionReferenceStore === store, "Prompt restoration belongs to another store.");
            const { completionReferenceMaintenance, ...preserved } = index;
            return { ...preserved, schemaVersion: 4, completionReferenceVersion: 1, completionReferenceStore: store,
                completionReferenceSources: index.completionReferenceSources ?? [] };
        },
        async validateState(state, plan, config, records, index, { allowPostimage = false } = {}) {
            validateTargets(plan.targets);
            metadataFiles = sourceHost(config);
            metadata = await readMetadata(metadataFiles);
            mappedTargets = plan.targets.map(target => {
                if (target.sourceMapping) return target;
                const retained = sourceForTarget(state.importCoverage?.roster ?? [], target);
                const current = sourceForTarget(metadata.roster, target);
                same(compatibleSourceBinding(current), compatibleSourceBinding(retained), "The compatible target's source mapping changed.");
                return { ...target, sourceMapping: { archived: false, sha256: digest(sourceBinding(current)) } };
            });
            await verifyMappings();
            for (const [position, target] of plan.targets.entries()) {
                const copies = occurrences(records, target);
                same(copies.map(row => JSON.stringify([row.record.scenarioId, row.field, row.index])).sort(),
                    target.aliases.map(alias => JSON.stringify([alias.scenarioId, alias.field, alias.index])).sort(),
                "The complete retained origin-copy population changed.");
                for (const row of copies) {
                    const alias = target.aliases.find(alias => alias.scenarioId === row.record.scenarioId && alias.field === row.field && alias.index === row.index);
                    requireThat(["copilot-app", "copilot-app-chat"].includes(row.record.sourceHost)
                        && !row.record.sample && !row.record.synthetic, "The retained copy is not qualified Copilot activity.");
                    if (!allowPostimage) requireThat(digest(row.record) === alias.recordSha256, "Retained origin record preimage changed.");
                    verifyPrompt(row.prompt, target, allowPostimage);
                }
                const child = verifyTargetMapping(metadata, mappedTargets[position]);
                const original = await readOriginal(config, index, target.sourceSessionId, target.sourceEvent);
                requireThat(original.type === "user.message" && original.id === target.prompt.sourceEventId
                    && original.timestamp === target.prompt.sourceTimestamp && typeof original.data?.content === "string"
                    && hash(original.data.content) === target.prompt.textSha256, "The exact original prompt no longer matches retained facts.");
                const first = index.sources[target.sourceSessionId]?.firstPromptEventId;
                const raw = promptAuthorship.fromEvent(original, {
                    agentCreatedFirstMessage: target.sourceMapping?.archived === true
                        || child.promptCreation?.actor === "agent" && (!first || first === original.id),
                });
                same(raw, target.prompt.authorship, "The exact original does not establish the proposed host origin.");
                projected.add(originKey(target.sourceSessionId, target.prompt.sourceEventId));
            }
            originalInputs = { config, index, targets: plan.targets };
        },
        projectRecords(records, plan) {
            for (const target of plan.targets) for (const alias of target.aliases) {
                const record = records.find(record => record.scenarioId === alias.scenarioId);
                requireThat(record && digest(record) === alias.recordSha256, "Retained origin preimage changed before projection.");
            }
            const next = structuredClone(records);
            for (const target of plan.targets) {
                requireThat(projected.has(originKey(target.sourceSessionId, target.prompt.sourceEventId)), "Original prompt qualification is missing.");
                for (const row of occurrences(next, target)) Object.assign(row.prompt, {
                    authorship: target.prompt.authorship, authorshipVersion: target.prompt.authorshipVersion,
                });
            }
            return next;
        },
        projectCheckpoint(checkpoint, sourceId, plan, state, index, { allowPostimage = false } = {}) {
            const targets = plan.targets.filter(target => target.sourceSessionId === sourceId);
            requireThat([1, 2].includes(checkpoint.schemaVersion) && Array.isArray(checkpoint.events), "Unsupported origin checkpoint.");
            validateReferenceCheckpoint(checkpoint, { index, sourceSessionId: sourceId });
            same(checkpoint.cursor, index.sources[sourceId].cursor, "Origin checkpoint cursor changed.");
            if (!allowPostimage) for (const target of targets) same(digest(checkpoint), target.checkpointContextSha256, "Origin checkpoint preimage changed.");
            const next = structuredClone(checkpoint);
            for (const target of targets) {
                const events = next.events.filter(event => event.id === target.prompt.sourceEventId);
                requireThat(events.length <= 1, "Duplicate retained prompt events.");
                if (target.checkpointOnly) requireThat(events.length === 1, "The sealed checkpoint-only prompt is missing; nothing is reconstructed.");
                if (!events.length) continue;
                const event = events[0];
                requireThat(event.type === "user.message" && event.timestamp === target.prompt.sourceTimestamp, "Retained prompt event identity changed.");
                verifyPrompt({ text: event.data?.content, sourceTimestamp: event.timestamp, capture: event.data?.wirePromptCapture,
                    authorship: event.data?.wirePromptAuthorship, authorshipVersion: event.data?.wirePromptAuthorshipVersion }, target, allowPostimage);
                event.data.wirePromptAuthorship = target.prompt.authorship;
                event.data.wirePromptAuthorshipVersion = target.prompt.authorshipVersion;
            }
            requireThat(contextFits(next.events), "Origin metadata exceeds checkpoint bounds; no context was evicted.");
            same(filterDeletedEvents(next.events, sourceId, state.deletion), next.events, "Deletion conflicts with origin restoration.");
            return next;
        },
    };
}

export function runPromptOriginRepair(options, hooks) {
    return runMetadataMaintenance(options, createPromptOriginRepairPolicy(options.dataDir), hooks);
}

async function inspectionStore(dataDir) {
    requireThat(typeof dataDir === "string" && path.isAbsolute(dataDir), "Prompt inspection requires an explicit absolute store.");
    const dir = resolveDataDir({ dataDir }), session = { dataDir: dir };
    const file = relative => safeDeletionFile(dir, relative);
    const controls = await Promise.all([`${BOARD_ID}.state.json`, path.join("collector", "config.json"),
        path.join("collector", "index.json")].map(file));
    const before = await Promise.all(controls.map(value => readFile(value)));
    const state = await loadBoardState(session, { readOnly: true }), config = JSON.parse(before[1]);
    requireThat(config.approved === true && assessmentSource(state, config).available === true, "Approve the source before inspecting original prompts.");
    const index = validateCollectorIndex(JSON.parse(before[2]));
    requireThat(!index.completionReferenceMaintenance, "An existing repair must finish before prompt inspection.");
    same(JSON.parse(JSON.stringify(state)), JSON.parse(before[0]), "Inspection would reinterpret stored state.");
    const snapshotBytes = await readFile(await file(path.join("private-evidence", state.evidenceFile)));
    requireThat(hash(snapshotBytes) + ".json" === state.evidenceFile, "Prompt evidence snapshot integrity failed.");
    return { dir, session, file, controls, before, state, config, index, snapshot: JSON.parse(snapshotBytes) };
}

function retainedAuthorPopulation(state) {
    const records = projectPromptOrigins(mergeEvidenceWithState(state).filter(record =>
        ["copilot-app", "copilot-app-chat"].includes(record.sourceHost)));
    const { rows } = buildActivitySelection(records, { layer: "tool", filters: { scope: "all", includeMetadata: false } });
    const owners = new Set(rows.map(row => row.scenarioId)), selected = records.filter(record => owners.has(record.scenarioId));
    requireThat(owners.size === selected.length, "The canonical interaction owners are missing or ambiguous.");
    const authors = createPercentageCharts({ authorship: promptAuthorship }).authorUsage(selected);
    return { calls: rows.length, selected, authors, unknown: new Set(authors.rows.find(group => group.id === "unknown").interactionIds) };
}

function originatingReviewCut(before, index, store) {
    const { sources, metrics, lastCheckedAt, ...controls } = index;
    const { totalBytesRead, cycles, lastBytesRead, lastSourcesChecked, lastDurationMs, ...otherMetrics } = metrics;
    // Other chats' progress is not evidence for this origin. Keep their source
    // membership/host ownership, every global fence and the entire board/config.
    const owners = Object.keys(sources).sort().map(id => [id, sources[id].cursor?.host ?? null]);
    const common = digest([store, hash(before[0]), hash(before[1]), controls, otherMetrics, owners]);
    return id => {
        const { lastCheckedAt, lastAttemptAt, ...selected } = sources[id] ?? {};
        return digest([common, selected]);
    };
}

// One charged scan page plus three full verification passes for four maximum-size
// originals fit the same cycle budget. Each subsequent page requires a new invocation.
const reviewBatchSize = 4;
export async function reviewPromptOriginClass({ dataDir, batch, continuation, includeOlder = false, includeArchived = false, countsOnly = false, originatingOnly = false }) {
    requireThat(batch === undefined ? continuation === undefined : sha(batch), "Choose a batch from the retained author list.");
    requireThat(typeof countsOnly === "boolean" && !(countsOnly && batch), "Aggregate inventory is a retained-only list operation.");
    requireThat(typeof originatingOnly === "boolean" && !(countsOnly && originatingOnly), "Choose counts or originating interaction cases, not both.");
    requireThat(typeof includeOlder === "boolean" && typeof includeArchived === "boolean", "Choose explicit historical review scope.");
    const { session, controls, before, state, config, index, snapshot } = await inspectionStore(dataDir);
    const checkStore = async () => same((await Promise.all(controls.map(file => readFile(file)))).map(hash), before.map(hash),
        "The author review changed. List the current retained candidates again.");
    const since = Math.max(Date.now() - config.windowDays * 86400000, Date.parse(state.importCoverage?.since));
    const until = Math.min(Date.now(), Date.parse(state.importCoverage?.until));
    const roster = state.importCoverage?.roster ?? [];
    const eligible = new Set(roster.filter(row => row.eligible).map(row => row.sessionId));
    const archived = new Set(roster.filter(row => includeArchived && !row.eligible && row.disposition === "archived"
        && row.localSourceVerified === true).map(row => row.sessionId));
    const population = countsOnly || originatingOnly ? retainedAuthorPopulation(state) : null;
    const groups = new Map(), sources = new Map(), excluded = {}, statusByOrigin = new Map();
    for (const record of snapshot.records) for (const prompt of [record.userPrompt, ...(record.followUpPrompts ?? [])]) {
        if (!uuid(record.sourceSessionId) || !id(prompt?.sourceEventId)) continue;
        const key = originKey(record.sourceSessionId, prompt.sourceEventId);
        if (originatingOnly && !population.unknown.has(key)) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ record, prompt });
    }
    for (const copies of groups.values()) {
        const { record: { sourceSessionId }, prompt } = copies[0];
        if (copies.every(row => promptAuthorship.read(row.prompt).actor !== "unknown")) continue;
        const reason = !eligible.has(sourceSessionId) && !archived.has(sourceSessionId) ? "source-outside-scope"
            : copies.some(row => !["copilot-app", "copilot-app-chat"].includes(row.record.sourceHost) || row.record.sample || row.record.synthetic)
                ? "unsupported-source-record"
            : copies.length > 8 || typeof prompt.text !== "string" || copies.some(row => row.prompt.capture?.conflict
                || row.prompt.text !== prompt.text || row.prompt.sourceTimestamp !== prompt.sourceTimestamp) ? "unverified-copies"
            : copies.some(row => !reviewableAuthor(row.prompt, true)) ? "not-older-unqualified"
            : !((includeOlder || Date.parse(prompt.sourceTimestamp) >= since) && Date.parse(prompt.sourceTimestamp) <= until)
                ? "outside-current-window" : null;
        if (countsOnly || originatingOnly) statusByOrigin.set(originKey(sourceSessionId, prompt.sourceEventId), reason ?? "candidate");
        if (reason) { excluded[reason] = (excluded[reason] ?? 0) + 1; continue; }
        if (countsOnly) continue;
        if (!sources.has(sourceSessionId)) sources.set(sourceSessionId, []);
        sources.get(sourceSessionId).push(prompt.sourceEventId);
    }
    const flags = { authorized: false, prepared: false };
    if (countsOnly) {
        const { authors, calls } = population;
        const reviewability = {};
        for (const group of authors.rows) if (group.id === "unknown") for (const key of group.interactionIds) {
            const reason = statusByOrigin.get(key) ?? "no-reviewable-origin";
            reviewability[reason] = (reviewability[reason] ?? 0) + 1;
        }
        await checkStore();
        return { status: "retained-counts", ...flags, revision: state.revision, classifierVersion: promptAuthorship.version,
            scope: "all-retained-copilot-tool-interactions", interactions: authors.total, calls,
            authors: Object.fromEntries(authors.rows.map(({ id, count }) => [id, count])),
            unverifiedReasons: authors.unverifiedReasons, reviewability, reviewScope: { includeOlder, includeArchived } };
    }
    const cut = digest(before.map(hash)), batches = [];
    const selectedCut = originatingOnly ? originatingReviewCut(before, index, completionReferenceStore(state, session.dataDir)) : null;
    for (const sourceSessionId of [...sources.keys()].sort()) {
        const ids = sources.get(sourceSessionId).sort();
        for (let i = 0; i < ids.length; i += reviewBatchSize) {
            const origins = ids.slice(i, i + reviewBatchSize);
            const source = index.sources?.[sourceSessionId], cursor = source?.cursor;
            batches.push({ batch: digest([promptAuthorship.version, selectedCut ? selectedCut(sourceSessionId) : cut, includeOlder, includeArchived, sourceSessionId, origins,
                ...(originatingOnly ? ["originating-interactions-v2"] : [])]), sourceSessionId, origins,
                ...(originatingOnly ? { consumedBytes: source?.scanned && !source.error && Number.isSafeInteger(cursor?.offset)
                    && cursor.offset > 0 && cursor.partialBytes === 0 && cursor.backlogBytes === 0 && sha(cursor.anchor) ? cursor.offset : null } : {}) });
        }
    }
    if (!batch && originatingOnly) {
        const slots = new Map(), evidence = new Map();
        for (const b of batches) for (const [i, event] of b.origins.entries()) {
            const key = originKey(b.sourceSessionId, event);
            requireThat(!slots.has(key), "An originating prompt belongs to multiple review slots.");
            slots.set(key, { batch: b.batch, position: i + 1 });
        }
        for (const record of population.selected) {
            const key = promptAuthorship.interactionIdentity(record);
            if (!population.unknown.has(key)) continue;
            if (!evidence.has(key)) evidence.set(key, []);
            evidence.get(key).push(record);
        }
        const cases = [...population.unknown].sort().map(key => {
            const owners = evidence.get(key);
            requireThat(owners?.length && owners.every(record => record.userPrompt?.sourceEventId || !groups.has(key)),
                "An originating case has an ambiguous fallback identity.");
            const copies = groups.get(key) ?? [];
            const reviewability = statusByOrigin.get(key) ?? (copies.length ? "known-origin-copy" : "no-reviewable-origin");
            const slot = slots.get(key);
            requireThat(Boolean(slot) === (reviewability === "candidate"), "An originating case has no unique matching review slot.");
            const qualifications = new Set(owners.map(record => {
                const { actor, basis, issue } = promptAuthorship.read(record.userPrompt);
                return JSON.stringify({ actor, basis, issue: issue ?? null, version: promptAuthorship.savedVersion(record.userPrompt) });
            }));
            const blockedCopies = reviewability === "not-older-unqualified" || reviewability === "known-origin-copy"
                ? copies.filter(({ prompt }) => !reviewableAuthor(prompt, true)).map(({ record, prompt }) => ({
                    role: record.userPrompt === prompt ? "origin" : "followup", ...promptAuthorship.read(prompt),
                    version: promptAuthorship.savedVersion(prompt),
                })) : [];
            const associations = [...new Set(owners.map(record => promptAuthorship.requestLink(record).association))].sort();
            return { caseRef: createHmac("sha256", state.pseudonymKey).update("wire-origin-case-v1\0" + key).digest("hex"),
                reviewability, qualifications: [...qualifications].sort().map(q => JSON.parse(q)), associations,
                ...(blockedCopies.length ? { blockedCopies } : {}),
                followUpCopies: copies.filter(({ record, prompt }) => record.userPrompt !== prompt).length, ...(slot ?? {}) };
        });
        requireThat(new Set(cases.map(c => c.caseRef)).size === cases.length && cases.length === population.authors.rows.find(r => r.id === "unknown").count
            && cases.filter(c => c.batch).length === slots.size, "The originating case inventory did not reconcile.");
        await checkStore();
        return { status: "retained-origin-cases", ...flags, revision: state.revision, classifierVersion: promptAuthorship.version,
            interactions: population.authors.total, calls: population.calls, authors: Object.fromEntries(population.authors.rows.map(r => [r.id, r.count])),
            reviewScope: { includeOlder, includeArchived }, cases, batches };
    }
    if (!batch) { await checkStore(); return { status: "retained-candidates", ...flags, batches, excluded }; }
    const selected = batches.find(row => row.batch === batch);
    requireThat(selected, "The selected author batch is stale or unavailable. List the candidates again.");
    const { sourceSessionId, origins: ids } = selected;
    const promptFor = id => groups.get(originKey(sourceSessionId, id))[0].prompt;
    const older = id => includeOlder && Date.parse(promptFor(id).sourceTimestamp) < since;
    const plan = { source: assessmentSource(state, config), stateGuardSha256: maintenanceStateGuard(state),
        targets: ids.map(id => ({ prompt: promptFor(id), olderRetained: older(id) })) };
    inspectMaintenanceState(state, plan, config, createPromptOriginRepairPolicy(dataDir));
    requireThat(index.fingerprint === sourceFingerprint(config), "The saved cursor does not belong to this source configuration.");
    await bindSourceHost(session, config);
    const access = sourceHost(config), recorded = roster.filter(row => row.sessionId === sourceSessionId), isArchived = archived.has(sourceSessionId);
    let acceptedProof, file, stamp;
    const verify = async () => {
        await checkStore();
        if (file) requireThat(sourceFileStamp(await stat(file)) === stamp, "The selected history changed during the author review.");
    };
    const proof = metadata => {
        const fresh = metadata.roster.filter(row => row.sessionId === sourceSessionId);
        requireThat(fresh.length === 1 && recorded.length === 1, "The author review needs a unique current source mapping.");
        const mapping = fresh[0];
        requireThat(isArchived ? !mapping.eligible && mapping.disposition === "archived" && mapping.localSourceVerified === true : mapping.eligible,
            "The historical review source is no longer eligible.");
        same(compatibleSourceBinding(mapping), compatibleSourceBinding(recorded[0]), "The retained and current author review source mappings disagree.");
        const result = selectedMetadataProof(metadata, mapping);
        if (acceptedProof) same(result, acceptedProof, "The reviewed author database or selected chat mapping changed.");
        return result;
    };
    const readMetadata = async files => {
        const metadata = await readSourceMetadata(files, { selection: { verify, proof } });
        acceptedProof = proof(metadata);
        return metadata;
    };
    let metadata = await readMetadata(access);
    const checkSelection = async () => {
        await verify();
        if (sourceMetadataStamp(access) !== metadata.metadataStamp) metadata = await readMetadata(access);
        requireThat(sourceMetadataStamp(access) === metadata.metadataStamp, "The selected source metadata changed again; no review was admitted.");
    };
    const source = index.sources?.[sourceSessionId], cursor = source?.cursor;
    requireThat(source?.scanned && !source.error && cursor?.offset > 0 && !cursor.partialBytes && !cursor.backlogBytes && sha(cursor.anchor),
        "The selected author's source must have a fully consumed cursor.");
    file = await safeDeletionFile(access.historyRoot(), path.join(sourceSessionId, "events.jsonl"));
    const info = await stat(file);
    stamp = sourceFileStamp(info);
    requireThat(info.isFile() && info.nlink === 1 && info.size === cursor.offset, "Unconsumed or linked history cannot establish unique originals.");
    const seal = core => createHmac("sha256", state.pseudonymKey).update(JSON.stringify(["wire-author-scan-v1", core])).digest("hex");
    // A paged review carries discovery, never a prepared write. Its checkpoint
    // preimage must survive the page boundary even if no board write occurred.
    let checkpointHash;
    if (originatingOnly && (continuation || info.size > TAIL_LIMITS.chunkBytes - 65536 - 512)) {
        const checkpoint = await safeDeletionFile(session.dataDir, path.join("collector", index.fingerprint, sourceSessionId + ".json"));
        const bytes = await readCheckpointPreimage(checkpoint);
        checkpointHash = hash(bytes);
    }
    const binding = digest([batch, stamp, acceptedProof, checkpointHash ?? null]);
    let core = { binding, cursor: null, startup: null, firstPrompt: null, found: {} };
    if (continuation !== undefined) {
        requireThat(continuation?.core?.binding === binding && continuation.seal === seal(continuation.core),
            "The author review continuation is stale or invalid. Start the named batch again.");
        core = structuredClone(continuation.core);
    }
    await checkSelection();
    const tail = await readTail(file, sourceSessionId, core.cursor, TAIL_LIMITS.chunkBytes, { chargeGuards: true, completionMetadata: true,
        pinOriginalIds: new Set(ids), fence: { identity: cursor.identity, endOffset: cursor.offset, anchor: cursor.anchor } });
    requireThat(tail.sourceStamp === stamp && !tail.fenceTruncated, "The selected author history changed or ended inside an entry.");
    requireThat(!tail.cursor.malformedLines, "A malformed source entry prevents a complete author review.");
    requireThat(!tail.cursor.oversizedLines, "An oversized source entry prevents a complete author review.");
    requireThat(tail.cursor.offset > (core.cursor?.offset ?? 0), "No complete source entry advanced the bounded author review.");
    for (const entry of tail.recovery.original) {
        const event = entry.event;
        const parsedDigest = digest(event), fullFields = entry.originalDigest === parsedDigest || entry.fieldsDigest === parsedDigest;
        // An unrelated payload cannot identify a sender. Its outer ID and type
        // must still be unique, including escaped keys, for collision/first-prompt checks.
        requireThat(fullFields || entry.offset && entry.uniqueOriginEnvelope === true,
            "The source event identity or startup fields are ambiguous; no unique original can be established.");
        if (!entry.offset) {
            requireThat(entry.endOffset <= 65536, "Startup exceeds the original-event verification limit.");
            core.startup = { startupBytes: entry.endOffset, startupSha256: entry.lineSha256 };
        }
        if (event.type === "user.message" && !core.firstPrompt) core.firstPrompt = hash(event.id);
        if (!ids.includes(event.id)) continue;
        const retained = promptFor(event.id);
        // Event IDs can also spell inherited JavaScript property names.
        const key = JSON.stringify(event.id);
        core.found[key] = Object.hasOwn(core.found, key) ? { reason: "duplicate-original" }
            : entry.oversizedOrigin ? { reason: "oversized-original" }
            : !fullFields ? { reason: "unverified-original-fields" }
            : event.type !== "user.message" || event.timestamp !== retained.sourceTimestamp || event.data?.content !== retained.text
                ? { reason: "original-mismatch" }
            : entry.endOffset - entry.offset > TAIL_LIMITS.maxLineBytes ? { reason: "oversized-original" }
            : { offset: entry.offset, bytes: entry.endOffset - entry.offset, sha256: entry.lineSha256 };
    }
    await checkSelection();
    if (tail.cursor.offset < cursor.offset) {
        core.cursor = tail.cursor;
        return { status: "continue", ...flags, batch, continuation: { core, seal: seal(core) } };
    }
    requireThat(!source.firstPromptEventId || core.firstPrompt === hash(source.firstPromptEventId),
        "The original first prompt does not match its retained source checkpoint.");
    const unresolved = [], origins = [];
    for (const sourceEventId of ids) {
        const hit = core.found[JSON.stringify(sourceEventId)];
        if (!hit || hit.reason) { unresolved.push({ sourceSessionId, sourceEventId, reason: hit?.reason ?? "original-not-found" }); continue; }
        origins.push({ sourceSessionId, sourceEventId, olderRetained: older(sourceEventId), ...(isArchived ? { includeArchived: true } : {}),
            sourceEvent: { sourceIdentity: cursor.identity, ...core.startup, ...hit, sourceStampSha256: hash(stamp) } });
    }
    const result = origins.length ? await inspectSelected({ dataDir, origins }, readMetadata)
        : { status: "nothing-qualified", ...flags, targets: [], unresolved: [] };
    await checkSelection();
    if (checkpointHash && result.checkpoints?.length) same(result.checkpoints[0].beforeSha256, checkpointHash,
        "The selected checkpoint changed before the final author review.");
    if (result.source) same(result.source.indexSha256, hash(before[2]), "The final author review requires one fresh exact index cut.");
    return { ...result, status: result.targets.length ? "reviewed" : "nothing-qualified", batch,
        unresolved: [...unresolved, ...result.unresolved] };
}

async function readCheckpointPreimage(file) {
    const h = await open(file, "r");
    try {
        const info = await h.stat();
        requireThat(info.isFile() && info.nlink === 1 && info.size <= TAIL_LIMITS.maxContextBytes + TAIL_LIMITS.maxPendingPromptBytes + 65536,
            "Prompt checkpoint exceeds its existing read bound.");
        const bytes = Buffer.alloc(info.size + 1);
        let n = 0;
        while (n < bytes.length) {
            const result = await h.read(bytes, n, bytes.length - n, n);
            if (!result.bytesRead) break;
            n += result.bytesRead;
        }
        requireThat(n === info.size && sourceFileStamp(info) === sourceFileStamp(await h.stat())
            && sourceFileStamp(info) === sourceFileStamp(await stat(file)), "The selected checkpoint changed during its read.");
        return bytes.subarray(0, n);
    } finally { await h.close(); }
}

export async function inspectPromptOriginRepair({ dataDir, targets, origins }) {
    return inspectSelected({ dataDir, targets, origins });
}

async function inspectSelected({ dataDir, targets, origins }, selectedRead) {
    requireThat((targets === undefined) !== (origins === undefined), "Choose exact targets or original selectors, not both.");
    if (origins) validateOrigins(origins);
    else validateTargets(targets);
    const { dir, session, file, controls, before, state, config, index, snapshot } = await inspectionStore(dataDir);
    const policy = originPolicy(dir, selectedRead), unresolved = [];
    if (origins) targets = origins.map(origin => {
        const prompt = { sourceEventId: origin.sourceEventId };
        const copies = occurrences(snapshot.records, { sourceSessionId: origin.sourceSessionId, prompt });
        requireThat(copies.length > 0 && copies.length <= 8, "The selected origin has no bounded retained copy set.");
        const first = copies[0].prompt;
        requireThat(instant(first.sourceTimestamp) && typeof first.text === "string"
            && copies.every(copy => copy.prompt.sourceTimestamp === first.sourceTimestamp && copy.prompt.text === first.text),
        "Retained origin copies disagree; no original was chosen.");
        return { sourceSessionId: origin.sourceSessionId, sourceEvent: origin.sourceEvent, olderRetained: origin.olderRetained,
            prompt: { ...prompt, sourceTimestamp: first.sourceTimestamp, textSha256: hash(first.text) } };
    });
    const plan = { targets, stateGuardSha256: maintenanceStateGuard(state),
        source: { configSha256: hash(before[1]), indexSha256: hash(before[2]), ...assessmentSource(state, config), windowDays: config.windowDays } };
    const noDispatchReason = inspectMaintenanceState(state, plan, config, policy);
    await bindSourceHost(session, config);
    if (origins) {
        const metadata = await (selectedRead ?? readSourceMetadata)(sourceHost(config)), derived = [], checkpoints = new Map();
        for (const [position, target] of targets.entries()) {
            const copies = occurrences(snapshot.records, target);
            if (copies.some(copy => promptAuthorship.read(copy.prompt).actor !== "unknown")) {
                unresolved.push({ sourceSessionId: target.sourceSessionId, sourceEventId: target.prompt.sourceEventId, reason: "known-origin-copy" });
                continue;
            }
            const rows = metadata.roster.filter(row => row.sessionId === target.sourceSessionId);
            requireThat(rows.length === 1, "The selected source mapping is unavailable or ambiguous.");
            const source = rows[0], archived = !source.eligible;
            requireThat(source.eligible || origins[position].includeArchived === true
                && source.disposition === "archived" && source.localSourceVerified === true, "The selected source is not eligible or explicitly included archived-local history.");
            const original = await readOriginal(config, index, target.sourceSessionId, target.sourceEvent);
            requireThat(original.type === "user.message" && original.id === target.prompt.sourceEventId
                && original.timestamp === target.prompt.sourceTimestamp && typeof original.data?.content === "string"
                && hash(original.data.content) === target.prompt.textSha256, "The exact original prompt no longer matches retained facts.");
            const first = index.sources[target.sourceSessionId]?.firstPromptEventId;
            const { authorship, observation } = promptAuthorship.reviewEvent(original, {
                agentCreatedFirstMessage: archived || source.promptCreation?.actor === "agent" && (!first || first === original.id),
            });
            if (!supportedOrigins.has(authorship.basis)) {
                unresolved.push({ sourceSessionId: target.sourceSessionId, sourceEventId: target.prompt.sourceEventId, reason: "author-unverified",
                    authorship, observation, sourceEvent: target.sourceEvent,
                    ...(observation.firstPromptGuard && observation.envelope === "direct"
                        ? { creatorEvidence: retainedCreatorEvidence(state, metadata, index, source, original) } : {}) });
                continue;
            }
            if (!checkpoints.has(target.sourceSessionId)) {
                const checkpointFile = await file(path.join("collector", index.fingerprint, `${target.sourceSessionId}.json`));
                const checkpoint = JSON.parse(await readCheckpointPreimage(checkpointFile));
                requireThat([1, 2].includes(checkpoint.schemaVersion) && Array.isArray(checkpoint.events),
                    "Prompt checkpoint changed or has an unsupported shape.");
                checkpoints.set(target.sourceSessionId, checkpoint);
            }
            const checkpoint = checkpoints.get(target.sourceSessionId);
            if (selectedRead) {
                const saved = checkpoint.events.filter(e => e.id === target.prompt.sourceEventId);
                if (saved.length > 1 || saved.some(e => e.type !== "user.message" || e.timestamp !== target.prompt.sourceTimestamp
                    || e.data?.content !== original.data.content || e.data?.wirePromptCapture?.conflict
                    || !reviewableAuthor({ authorship: e.data?.wirePromptAuthorship, authorshipVersion: e.data?.wirePromptAuthorshipVersion }, true))) {
                    unresolved.push({ sourceSessionId: target.sourceSessionId, sourceEventId: target.prompt.sourceEventId, reason: "incompatible-checkpoint-copy" });
                    continue;
                }
            }
            const legacy = copies.some(copy => copy.prompt.authorship === undefined && copy.prompt.authorshipVersion === undefined)
                || checkpoint.events.some(event => event.id === target.prompt.sourceEventId
                    && event.data?.wirePromptAuthorship === undefined && event.data?.wirePromptAuthorshipVersion === undefined);
            derived.push({ ...target, prompt: { ...target.prompt, authorship, authorshipVersion: promptAuthorship.version },
                kickoff: null, aliases: copies.map(copy => ({ scenarioId: copy.record.scenarioId, recordSha256: digest(copy.record),
                    field: copy.field, index: copy.index })),
                checkpointContextSha256: digest(checkpoint), sourceMapping: { archived, sha256: digest(sourceBinding(source)),
                    ...(selectedRead ? { metadataSha256: selectedMetadataProof(metadata, source) } : {}) },
                ...(legacy ? { legacyUnqualified: true } : {}) });
        }
        targets = derived;
        plan.targets = targets;
        if (!targets.length) {
            same((await Promise.all(controls.map(value => readFile(value)))).map(hash), before.map(hash), "Prompt review's retained read cut changed.");
            return { kind: "read-only-prompt-origin-projection", status: "nothing-qualified", prepared: false, authorized: false,
                noDispatchReason, stateRevision: state.revision, targets, unresolved };
        }
    }
    await policy.validateState(state, plan, config, snapshot.records, index);
    const projectedIndex = validateCollectorIndex(policy.projectIndex(index, plan, state));
    const records = policy.projectRecords(snapshot.records, plan), checkpoints = [];
    for (const sourceId of [...new Set(targets.map(target => target.sourceSessionId))]) {
        const name = path.join("collector", index.fingerprint, `${sourceId}.json`), target = await file(name);
        const bytes = await readCheckpointPreimage(target), previous = JSON.parse(bytes);
        const next = policy.projectCheckpoint(previous, sourceId, plan, state, projectedIndex, {});
        checkpoints.push({ sourceSessionId: sourceId, path: name, beforeSha256: hash(bytes),
            afterSha256: digest(previous) === digest(next) ? hash(bytes) : digest(next), cursorUnchanged: true,
            prompts: targets.filter(target => target.sourceSessionId === sourceId).map(target => {
                const event = previous.events.find(event => event.id === target.prompt.sourceEventId);
                return { sourceEventId: target.prompt.sourceEventId, checkpointOnly: target.checkpointOnly === true,
                    retained: Boolean(event), before: event ? promptAuthorship.read({ authorship: event.data?.wirePromptAuthorship }) : null,
                    proposed: event ? target.prompt.authorship : null };
            }) });
        requireThat(hash(await readCheckpointPreimage(target)) === hash(bytes), "Prompt checkpoint changed during inspection.");
    }
    same((await Promise.all(controls.map(value => readFile(value)))).map(hash), before.map(hash),
        "Prompt inspection's live read cut changed; no preparation or writes occurred.");
    await policy.verifyInputs();
    return { kind: "read-only-prompt-origin-projection", prepared: false, authorized: false, noDispatchReason,
        targets, unresolved,
        stateRevision: state.revision, evidenceFile: state.evidenceFile, stateGuardSha256: plan.stateGuardSha256,
        source: plan.source, proposedEvidenceFile: digest({ ...snapshot, records }) + ".json", checkpoints,
        indexBeforeSchema: index.schemaVersion, indexAfterSchema: projectedIndex.schemaVersion,
        indexBeforeSha256: hash(before[2]), indexAfterSha256: digest(projectedIndex),
        matchedReaderRequired: true, pendingFence: "completionReferenceMaintenance",
        origins: targets.map(target => ({ sourceSessionId: target.sourceSessionId, sourceEventId: target.prompt.sourceEventId,
            copies: target.aliases.length, checkpointOnly: target.checkpointOnly === true,
            before: occurrences(snapshot.records, target).map(row => ({ scenarioId: row.record.scenarioId,
                field: row.field, index: row.index, authorship: promptAuthorship.read(row.prompt), authorshipVersion: row.prompt.authorshipVersion })),
            proposed: target.prompt.authorship, authorshipVersion: target.prompt.authorshipVersion })) };
}
