import { lstat } from "node:fs/promises";
import path from "node:path";
import { contextFits, hash, readTail, sourceFileStamp, TAIL_LIMITS } from "./collector-io.mjs";
import { safeDeletionFile } from "./deletion-storage.mjs";
import { filterDeletedEvents } from "./deletion-identities.mjs";
import { createPromptLinks } from "./prompt-linkage.mjs";
import { qualifiedResultPaths, returnedTextBytes } from "./history.mjs";
import { bindSourceHost, sourceHost } from "./source-host.mjs";
import { readSourceMetadata } from "./source-reader.mjs";
import { sessionStorage, UUID } from "./microsoft-session-state.mjs";
import { completionReferenceStore, validateReferenceCheckpoint, hasCompletionReference } from "./checkpoint-references.mjs";
import { maintenanceMetadata, runMetadataMaintenance, validateMaintenancePlan } from "./historical-maintenance.mjs";

const { digest, id, instant, requireThat, same, sha, shape } = maintenanceMetadata;
const maximumRead = 8 * 1024 ** 2;
const kind = "workiq-returned-text-bytes-v1";
function one(rows, message) { requireThat(rows.length === 1, message); return rows[0]; }
function validatePlan(plan) {
    validateMaintenancePlan(plan);
    requireThat(Array.isArray(plan.targets), "Review one interaction's exact returned-text carriers.");
    const t = one(plan.targets, "Review exactly one retained interaction.");
    shape(t, ["kind", "sourceSessionId", "scenarioId", "prompt", "calls", "recordSha256", "checkpointSha256",
        "originalsSha256", "sourceStampSha256", "mappingSha256", "accountSha256", "lifecycleSha256", "storeRef"]);
    shape(t.prompt, ["sourceEventId", "sourceTimestamp"]);
    requireThat(t.kind === kind && UUID.test(t.sourceSessionId) && id(t.scenarioId) && id(t.prompt.sourceEventId)
        && instant(t.prompt.sourceTimestamp) && [t.recordSha256, t.checkpointSha256, t.originalsSha256, t.sourceStampSha256,
            t.mappingSha256, t.accountSha256, t.lifecycleSha256, t.storeRef].every(sha), "Invalid byte-size review bindings.");
    requireThat(Array.isArray(t.calls) && t.calls.length === 3, "Review the three successful returns only.");
    same(t.calls.map(c => c?.tool).sort(), ["workiq-fetch", "workiq-retrieve", "workiq-retrieve"], "Review the three successful returns only.");
    for (const c of t.calls) {
        shape(c, ["tool", "toolCallId", "startEventId", "completionEventId", "startedAt", "completedAt", "requestEventId",
            "bytes", "callBefore", "callAfter", "completionBefore", "completionAfter"]);
        requireThat([c.toolCallId, c.startEventId, c.completionEventId, c.requestEventId].every(id)
            && instant(c.startedAt) && instant(c.completedAt) && Date.parse(c.startedAt) >= Date.parse(t.prompt.sourceTimestamp)
            && Date.parse(c.completedAt) >= Date.parse(c.startedAt) && Number.isSafeInteger(c.bytes) && c.bytes >= 0
            && c.bytes <= TAIL_LIMITS.maxLineBytes && [c.callBefore, c.callAfter, c.completionBefore, c.completionAfter].every(sha),
        "Invalid returned-text call or carrier seals.");
    }
    requireThat(new Set(t.calls.map(c => c.toolCallId)).size === 3 && new Set(t.calls.flatMap(c => [c.startEventId, c.completionEventId])).size === 6,
        "Repeated call or event in byte-size review.");
}

function addSize(value, field, bytes, before, after, applied) {
    if (applied) {
        requireThat(value[field] === bytes && digest(value) === after, "Recorded byte-size postimage differs.");
        return value;
    }
    requireThat(!Object.hasOwn(value, field) && digest(value) === before, "Recorded byte-size preimage differs.");
    const next = { ...value, [field]: bytes };
    same(digest(next), after, "Proposed byte-size postimage differs.");
    return next;
}

// Use the collector's bounded, identity-fenced reader and explicit prompt/connector links.
// The full consumed generation disambiguates repeated identities; only named original-line hashes escape.
async function checkOriginals(file, t, cursor, managed, state, record, failed) {
    const pins = new Set([t.prompt.sourceEventId, ...t.calls.flatMap(c => [c.startEventId, c.completionEventId, c.requestEventId])]);
    const events = [], hashes = new Map(), fence = { identity:cursor.identity, endOffset:cursor.offset, anchor:cursor.anchor };
    let position, budget = maximumRead;
    do {
        const tail = await readTail(file, t.sourceSessionId, position, budget,
            { fence, chargeGuards:true, completionMetadata:true, pinOriginalIds:pins });
        budget -= tail.bytesRead;
        requireThat(tail.cursor.offset > (position?.offset ?? 0) && !tail.fenceTruncated && !tail.cursor.malformedLines
            && !tail.cursor.oversizedLines && !tail.recovery.projected.length, "Incomplete original history cannot establish a size.");
        events.push(...tail.events);
        for (const entry of tail.recovery.original) if (pins.has(entry.event.id)) {
            const fields = digest(entry.event);
            requireThat(!hashes.has(entry.event.id) && sha(entry.lineSha256) && [entry.originalDigest, entry.fieldsDigest].includes(fields)
                && !entry.event.checkpoint && !entry.event.ephemeral && !entry.event.agentId
                && !Object.keys(entry.event.data ?? {}).some(key => key.startsWith("wire")), "Ambiguous or unsupported original event.");
            hashes.set(entry.event.id, entry.lineSha256);
        }
        position = tail.cursor;
    } while (position.offset !== cursor.offset);
    requireThat(hashes.size === pins.size && digest([...hashes]) === t.originalsSha256, "The reviewed original bytes changed.");
    const selected = events.filter(e => pins.has(e.id));
    same(filterDeletedEvents(selected, t.sourceSessionId, state.deletion), selected, "Deleted original facts cannot be restored.");
    const prompt = selected.find(e => e.id === t.prompt.sourceEventId);
    requireThat(prompt.type === "user.message" && prompt.timestamp === t.prompt.sourceTimestamp && prompt.data.content === record.userPrompt.text,
        "Original prompt changed.");
    const owners = createPromptLinks(events), qualified = qualifiedResultPaths(events, [], managed, true);
    for (const c of t.calls) {
        const start = selected.find(e => e.id === c.startEventId), end = selected.find(e => e.id === c.completionEventId);
        const owner = owners(start, prompt);
        const call = record.toolCalls.find(v => v.toolCallId === c.toolCallId);
        same(start.data.arguments ?? {}, call.requestArgs, "Original call arguments changed.");
        requireThat(start.type === "tool.execution_start" && start.data.toolCallId === c.toolCallId && start.timestamp === c.startedAt
            && (start.data.turnId ?? null) === call.turnId && (start.data.parentToolCallId ?? null) === call.parentToolCallId
            && `workiq-${start.data.mcpToolName ?? start.data.toolName?.replace(/^workiq-/, "")}` === c.tool
            && end.data.toolCallId === c.toolCallId && end.timestamp === c.completedAt && end.data.success === true && qualified.has(end)
            && owner?.method === "explicit-message" && owner.event === prompt && owner.requestEventId === c.requestEventId
            && returnedTextBytes(end.data.result) === c.bytes, "Original call, explicit prompt link or measured byte count changed.");
    }
    const timeout = one(events.filter(e => e.id === failed.completionEventId || e.type === "tool.execution_complete" && e.data?.toolCallId === failed.toolCallId),
        "The original timeout is missing or ambiguous.");
    requireThat(timeout.id === failed.completionEventId && timeout.timestamp === failed.completedAt && timeout.data?.success === false
        && timeout.data.toolCallId === failed.toolCallId && timeout.data.result == null && /MCP error 1004:\s*Work\s?IQ took too long to respond/i.test(timeout.data.error?.message),
        "The fourth call is not the unchanged, unsized timeout.");
}

export async function runReturnedTextRepair(options, hooks) {
    const { dataDir, mode } = options;
    requireThat(path.isAbsolute(dataDir) && ["prepare", "apply", "resume"].includes(mode), "Choose a sealed byte-size maintenance operation.");
    const lifecycle = sessionStorage({dataDir});
    await safeDeletionFile(dataDir, path.join("microsoft-session", "session.json"));
    requireThat(await lifecycle.read(), "An existing signed-in WIRE instance is required.");
    const unlock = await lifecycle.lock();
    let checkInputs, failedCall;
    try {
        return await runMetadataMaintenance({ ...options, mode: mode === "resume" ? "apply" : mode }, {
            validatePlan, transientFence:true,
            targetWindow:t => ({from:t.prompt.sourceTimestamp, to:new Date(Math.max(...t.calls.map(c => Date.parse(c.completedAt)))).toISOString()}),
            checkDispatch(phase, core, boardHash, indexHash) {
                if (mode === "apply") requireThat(phase === "prepared" && boardHash === core.state.beforeSha256 && indexHash === core.index?.beforeSha256,
                    "Apply requires an undispatched byte-size review. Inspect the same journal before resuming.");
                else requireThat(["applying","compatibility-fence","checkpoint-1","snapshot-staged","board-saved","complete"].includes(phase)
                    && (indexHash === core.index?.pendingSha256 || phase === "complete" && boardHash === core.state.afterSha256 && indexHash === core.index?.afterSha256),
                    "The prior dispatch is uncertain; no byte-size operation was sent.");
            },
            projectIndex(index, plan) {
                const { completionReferenceMaintenance, ...clear } = index;
                if (!completionReferenceMaintenance) return clear;
                const { completionReferenceVersion, completionReferenceStore, completionReferenceSources, ...legacy } = clear;
                return digest(clear) === plan.source.indexSha256 ? clear : { ...legacy, schemaVersion:3 };
            },
            async validateState(state, plan, config, records, index, { allowPostimage }) {
                const [t] = plan.targets;
                same(t.storeRef, completionReferenceStore(state, dataDir), "Byte-size review belongs to another store.");
                if (index.schemaVersion === 4) same(index.completionReferenceStore, t.storeRef, "Collector belongs to another store.");
                const source = index.sources?.[t.sourceSessionId], cursor = source?.cursor;
                requireThat(source?.scanned && !source.error && !source.backfillPending && cursor?.offset === cursor?.logBytes && cursor.offset > 0
                    && cursor.offset <= maximumRead - 512 * 1024 && !cursor.droppedBytes && !cursor.partialBytes && !cursor.backlogBytes && !cursor.skipping,
                "The approved source does not have a complete bounded checkpoint.");
                const record = one(records.filter(r => r.scenarioId === t.scenarioId || r.sourceSessionId === t.sourceSessionId
                    && r.userPrompt?.sourceEventId === t.prompt.sourceEventId), "The retained prompt is missing or ambiguous.");
                requireThat(record.scenarioId === t.scenarioId && record.sourceSessionId === t.sourceSessionId && record.sourceHost === "copilot-app"
                    && !record.sample && !record.synthetic && !record.isLegacy && !record.assessmentMembershipPruned
                    && record.userPrompt?.sourceEventId === t.prompt.sourceEventId && record.userPrompt.sourceTimestamp === t.prompt.sourceTimestamp
                    && typeof record.userPrompt.text === "string" && record.toolCalls.length === 4, "Retained interaction binding changed.");
                const before = structuredClone(record);
                for (const c of t.calls) {
                    const actual = one(records.filter(r => r.sourceSessionId === t.sourceSessionId).flatMap(r => r.toolCalls ?? [])
                        .filter(v => v.toolCallId === c.toolCallId || v.startEventId === c.startEventId || v.completionEventId === c.completionEventId),
                    "Retained call is missing or ambiguous.");
                    requireThat(record.toolCalls.includes(actual) && actual.toolSucceeded === true && actual.reportedOutcome === "succeeded"
                        && actual.promptLink?.promptEventId === t.prompt.sourceEventId && actual.promptLink.requestEventId === c.requestEventId
                        && ["tool","toolCallId","startEventId","completionEventId","startedAt","completedAt"].every(k => c[k] === actual[k]), "Retained call binding changed.");
                    addSize(actual, "returnedTextBytes", c.bytes, c.callBefore, c.callAfter, allowPostimage);
                    delete before.toolCalls.find(v => v.toolCallId === c.toolCallId).returnedTextBytes;
                }
                failedCall = one(record.toolCalls.filter(c => c.tool === "workiq-ask" && c.toolSucceeded === false && !Object.hasOwn(c,"returnedTextBytes")),
                    "The failed ask must remain unsized.");
                same(digest(before),t.recordSha256,"Another retained field changed.");
                await lstat(await safeDeletionFile(dataDir, path.join("collector", index.fingerprint, `${t.sourceSessionId}.json`)));
                await bindSourceHost({dataDir},config);
                const files = sourceHost(config), file = await safeDeletionFile(files.historyRoot(), path.join(t.sourceSessionId, "events.jsonl"));
                checkInputs = async () => {
                    const session = await lifecycle.read();
                    requireThat(session?.wire === "signed-in" && session.owner === null && digest(session) === t.lifecycleSha256, "WIRE sign-in or consent changed.");
                    const profile = await readSourceMetadata(files, { profileOnly:true });
                    requireThat(profile.state === "available" && digest([profile.sourceIdentity,profile.account.host,profile.account.id,
                        profile.account.login.toLowerCase()]) === t.accountSha256, "The reviewed Copilot account changed.");
                    const metadata = await readSourceMetadata(files, { includeIdentity:true });
                    const row = one(metadata.roster.filter(r => r.sessionId === t.sourceSessionId && r.eligible), "The selected source is not eligible.");
                    const { checkedAt, ...mapping } = row;
                    same(digest(mapping),t.mappingSha256,"Selected chat or connector mapping changed.");
                    requireThat(metadata.sourceIdentity === profile.sourceIdentity && metadata.metadataStamp === profile.metadataStamp,
                        "Account and source mapping do not share a verified read.");
                    const info = await lstat(file);
                    requireThat(info.isFile() && info.nlink === 1 && info.size === cursor.offset && hash(sourceFileStamp(info)) === t.sourceStampSha256,
                        "The reviewed source journal changed.");
                    return new Set(row.managedWorkIqEventIds ?? []);
                };
                const managed = await checkInputs();
                await checkOriginals(file, t, cursor, managed, state, record, failedCall);
                const previous = checkInputs;
                checkInputs = async () => same([...(await previous())].sort(), [...managed].sort(), "The reviewed connector mapping changed.");
                await checkInputs();
            },
            verifyInputs:() => checkInputs(),
            projectRecords(records, plan) {
                const [t] = plan.targets;
                return records.map(r => r.scenarioId !== t.scenarioId ? r : {...r, toolCalls:r.toolCalls.map(v => {
                    const c = t.calls.find(c => c.toolCallId === v.toolCallId);
                    return c ? addSize(v,"returnedTextBytes",c.bytes,c.callBefore,c.callAfter,false) : v;
                })});
            },
            projectCheckpoint(checkpoint, sid, plan, state, index, { allowPostimage }) {
                const [t] = plan.targets;
                validateReferenceCheckpoint(checkpoint,{index,sourceSessionId:sid});
                same(checkpoint.cursor,index.sources[sid].cursor,"Collector and checkpoint cursors differ.");
                const timeout = one(checkpoint.events.filter(e => e.id === failedCall.completionEventId || e.type === "tool.execution_complete"
                    && e.data?.toolCallId === failedCall.toolCallId), "The failed checkpoint completion is missing or ambiguous.");
                requireThat(timeout.type === "tool.execution_complete" && timeout.id === failedCall.completionEventId && timeout.timestamp === failedCall.completedAt
                    && timeout.data?.success === false && timeout.data.toolCallId === failedCall.toolCallId && timeout.data.wireReturnedTextBytes == null,
                    "A failed checkpoint completion cannot gain or lose a size.");
                const next = structuredClone(checkpoint), before = structuredClone(checkpoint);
                for (const c of t.calls) {
                    const start = one(next.events.filter(e => e.id === c.startEventId || e.type === "tool.execution_start" && e.data?.toolCallId === c.toolCallId),
                        "Checkpoint start is missing or ambiguous.");
                    requireThat(start.id === c.startEventId && start.type === "tool.execution_start" && start.timestamp === c.startedAt
                        && start.data.toolCallId === c.toolCallId && `workiq-${start.data.mcpToolName ?? start.data.toolName?.replace(/^workiq-/, "")}` === c.tool,
                        "The reviewed checkpoint start changed.");
                    const event = one(next.events.filter(e => e.id === c.completionEventId || e.type === "tool.execution_complete" && e.data?.toolCallId === c.toolCallId),
                        "Checkpoint completion is missing or ambiguous.");
                    requireThat(event.id === c.completionEventId && event.type === "tool.execution_complete" && event.timestamp === c.completedAt
                        && event.data?.toolCallId === c.toolCallId && event.data.success === true && !hasCompletionReference(event)
                        && Object.hasOwn(event.data,"wireResultEvidence"), "Checkpoint cannot carry this measured return.");
                    const original = before.events.find(e => e.id === event.id);
                    delete original.data.wireReturnedTextBytes;
                    same(digest(original),c.completionBefore,"Checkpoint completion preimage differs.");
                    if (allowPostimage) same(event.data.wireReturnedTextBytes,c.bytes,"Checkpoint byte-size postimage differs.");
                    else requireThat(!Object.hasOwn(event.data,"wireReturnedTextBytes"),"Checkpoint already has a return size.");
                    event.data.wireReturnedTextBytes = c.bytes;
                    same(digest(event),c.completionAfter,"Proposed checkpoint completion differs.");
                }
                requireThat(digest(before) === t.checkpointSha256 && contextFits(next.events), "Checkpoint changed or its postimage exceeds the context limit.");
                same(filterDeletedEvents(next.events,sid,state.deletion),next.events,"Byte-size correction conflicts with deletion.");
                return next;
            },
        }, hooks);
    } finally { await unlock(); }
}
