import { open, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { promptAuthorship } from "./prompt-authorship.mjs";
import { hash, contextFits, sourceFileStamp, TAIL_LIMITS } from "./collector-io.mjs";
import { sourceHost, bindSourceHost } from "./source-host.mjs";
import { hostPaths } from "./host-paths.mjs";
import { safeDeletionFile } from "./deletion-storage.mjs";
import { filterDeletedEvents } from "./deletion-identities.mjs";
import { runMetadataMaintenance, validateMaintenancePlan, maintenanceMetadata, maintenanceStateGuard, inspectMaintenanceState } from "./historical-maintenance.mjs";
import { loadBoardState, resolveDataDir } from "./store.mjs";
import { validateCollectorIndex } from "./collector-index.mjs";
import { assessmentSource } from "./assessment-read-model.mjs";
import { BOARD_ID } from "./evidence.mjs";
import { completionReferenceStore, validateReferenceCheckpoint } from "./checkpoint-references.mjs";
import { readSourceMetadata, sourceMetadataStamp } from "./source-reader.mjs";

const { digest, sha, id, instant, requireThat, same, shape } = maintenanceMetadata;
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const originKey = (source, event) => JSON.stringify([source, event]);
const supportedOrigins = new Set(["source-user", "source-agent", "autopilot", "host-direct-input", "host-agent-envelope"]);
// Qualification, pre-effect and pre-publication; inspection uses derivation as its first pass.
const originalReadBudget = pin => 3 * (2 * pin.bytes + pin.startupBytes + 1);
const sourceBinding = row => ({
    adapter: row.adapter, sessionId: row.sessionId, appId: row.appId, projectId: row.projectId, projectType: row.projectType,
    workspaceIds: row.workspaceIds, activeWorkspaceIds: row.activeWorkspaceIds, archiveEvidence: row.archiveEvidence,
    archivedAt: row.archivedAt, eligible: row.eligible, disposition: row.disposition,
    localSourceVerified: row.localSourceVerified ?? null, promptCreation: row.promptCreation,
});
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
    shape(pin, ["sourceIdentity", "offset", "bytes", "sha256", "startupBytes", "startupSha256"]);
    requireThat(typeof pin.sourceIdentity === "string" && pin.sourceIdentity.length <= 512
        && Number.isSafeInteger(pin.startupBytes) && pin.startupBytes > 0 && pin.startupBytes <= 65536
        && Number.isSafeInteger(pin.offset) && pin.offset >= pin.startupBytes
        && Number.isSafeInteger(pin.bytes) && pin.bytes > 0 && pin.bytes <= TAIL_LIMITS.maxLineBytes
        && Number.isSafeInteger(pin.offset + pin.bytes) && sha(pin.sha256) && sha(pin.startupSha256),
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
            shape(target.sourceMapping, ["archived", "sha256"]);
            requireThat(typeof target.sourceMapping.archived === "boolean" && sha(target.sourceMapping.sha256), "Invalid exact source mapping guard.");
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
        requireThat(sourceFileStamp(before) === sourceFileStamp(await handle.stat()), "Original prompt source changed during validation.");
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
    const legacy = target.legacyUnqualified === true && prompt.authorship === undefined && prompt.authorshipVersion === undefined;
    requireThat(author.actor === "unknown" && (legacy || ["invalid-source", "unsupported-source", "conflicting-source"].includes(author.basis)
        && Number.isSafeInteger(prompt.authorshipVersion) && prompt.authorshipVersion < promptAuthorship.version),
    "The prompt is not the reviewed older unqualified origin.");
}

export function createPromptOriginRepairPolicy(dataDir) {
    const projected = new Set();
    let metadata, metadataFiles, mappedTargets, originalInputs;
    async function verifyMappings() {
        if (!mappedTargets?.length) return;
        if (!metadata || sourceMetadataStamp(metadataFiles) !== metadata.metadataStamp) metadata = await readSourceMetadata(metadataFiles);
        for (const target of mappedTargets) sourceForTarget(metadata.roster, target);
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
            mappedTargets = plan.targets.filter(target => target.sourceMapping);
            metadataFiles = sourceHost(config);
            await verifyMappings();
            for (const target of plan.targets) {
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
                const child = sourceForTarget(target.sourceMapping ? metadata.roster : state.importCoverage?.roster ?? [], target);
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

export async function inspectPromptOriginRepair({ dataDir, targets, origins }) {
    requireThat(typeof dataDir === "string" && path.isAbsolute(dataDir), "Prompt inspection requires an explicit absolute store.");
    requireThat((targets === undefined) !== (origins === undefined), "Choose exact targets or original selectors, not both.");
    if (origins) validateOrigins(origins);
    else validateTargets(targets);
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
    const snapshot = JSON.parse(snapshotBytes), policy = createPromptOriginRepairPolicy(dir), unresolved = [];
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
        const metadata = await readSourceMetadata(sourceHost(config)), derived = [], checkpoints = new Map();
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
            const authorship = promptAuthorship.fromEvent(original, {
                agentCreatedFirstMessage: archived || source.promptCreation?.actor === "agent" && (!first || first === original.id),
            });
            if (!supportedOrigins.has(authorship.basis)) {
                unresolved.push({ sourceSessionId: target.sourceSessionId, sourceEventId: target.prompt.sourceEventId, reason: "author-unverified", authorship });
                continue;
            }
            if (!checkpoints.has(target.sourceSessionId)) {
                const checkpointFile = await file(path.join("collector", index.fingerprint, `${target.sourceSessionId}.json`));
                const info = await lstat(checkpointFile);
                requireThat(info.isFile() && info.size <= TAIL_LIMITS.maxContextBytes + TAIL_LIMITS.maxPendingPromptBytes + 65536,
                    "Prompt checkpoint exceeds its existing read bound.");
                const bytes = await readFile(checkpointFile), checkpoint = JSON.parse(bytes);
                requireThat(bytes.length === info.size && [1, 2].includes(checkpoint.schemaVersion) && Array.isArray(checkpoint.events),
                    "Prompt checkpoint changed or has an unsupported shape.");
                checkpoints.set(target.sourceSessionId, checkpoint);
            }
            const checkpoint = checkpoints.get(target.sourceSessionId);
            const legacy = copies.some(copy => copy.prompt.authorship === undefined && copy.prompt.authorshipVersion === undefined)
                || checkpoint.events.some(event => event.id === target.prompt.sourceEventId
                    && event.data?.wirePromptAuthorship === undefined && event.data?.wirePromptAuthorshipVersion === undefined);
            derived.push({ ...target, prompt: { ...target.prompt, authorship, authorshipVersion: promptAuthorship.version },
                kickoff: null, aliases: copies.map(copy => ({ scenarioId: copy.record.scenarioId, recordSha256: digest(copy.record),
                    field: copy.field, index: copy.index })),
                checkpointContextSha256: digest(checkpoint), sourceMapping: { archived, sha256: digest(sourceBinding(source)) },
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
        const info = await lstat(target);
        requireThat(info.isFile() && info.size <= TAIL_LIMITS.maxContextBytes + TAIL_LIMITS.maxPendingPromptBytes + 65536,
            "Prompt checkpoint exceeds its existing read bound.");
        const bytes = await readFile(target), previous = JSON.parse(bytes);
        requireThat(bytes.length === info.size, "Prompt checkpoint changed while read.");
        const next = policy.projectCheckpoint(previous, sourceId, plan, state, projectedIndex, {});
        checkpoints.push({ sourceSessionId: sourceId, path: name, beforeSha256: hash(bytes),
            afterSha256: digest(previous) === digest(next) ? hash(bytes) : digest(next), cursorUnchanged: true,
            prompts: targets.filter(target => target.sourceSessionId === sourceId).map(target => {
                const event = previous.events.find(event => event.id === target.prompt.sourceEventId);
                return { sourceEventId: target.prompt.sourceEventId, checkpointOnly: target.checkpointOnly === true,
                    retained: Boolean(event), before: event ? promptAuthorship.read({ authorship: event.data?.wirePromptAuthorship }) : null,
                    proposed: event ? target.prompt.authorship : null };
            }) });
        requireThat(hash(await readFile(target)) === hash(bytes), "Prompt checkpoint changed during inspection.");
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
