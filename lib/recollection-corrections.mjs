import { lstat, open } from "node:fs/promises";
import { lstatSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { safeDeletionFile } from "./deletion-storage.mjs";
import { readCompletionLookbehind, sourceFileStamp, TAIL_LIMITS, contextFits, hash } from "./collector-io.mjs";
import { validateReferenceCheckpoint, hasCompletionReference } from "./checkpoint-references.mjs";
import { loadBackfillCheckpoint } from "./collector-backfill-store.mjs";
import { isIncompleteWorkIqCall, recoverSameReadCompletions } from "./completion-recovery.mjs";
import { completeWorkIqCall } from "./history.mjs";
import { isWorkIqTool } from "./graph-history.mjs";
import { filterDeletedRecords, filterDeletedEvents } from "./deletion-identities.mjs";
import { textFindings } from "./privacy.mjs";
import { BoardError } from "./store.mjs";

const changed = stage => new BoardError(`The selected recovery checkpoint changed ${stage}. Preview again.`, 409);

// Only correct a canonical record when no checkpoint needs a different postimage.
// Changing a retained completion carrier requires the separate sealed maintenance protocol.
export async function correctionContext(dir, index, sourceId) {
    const row = index.sources?.[sourceId];
    if (!row?.scanned || row.error || !row.cursor || index.completionReferenceMaintenance
        || !/^[a-f0-9]{64}$/.test(index.fingerprint ?? "")) return null;
    const root = path.join(dir, "collector");
    const file = await safeDeletionFile(root, path.join(index.fingerprint, `${sourceId}.json`));
    let info;
    try { info = await lstat(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
    if (!info.isFile() || info.nlink !== 1 || info.size > TAIL_LIMITS.maxPendingPromptBytes + TAIL_LIMITS.maxContextBytes + 65536) return null;
    const handle = await open(file, "r");
    let bytes, stamp;
    try {
        const opened = await handle.stat(), openedStamp = sourceFileStamp(opened);
        // Opening an atomically renamed Windows file can refresh cached path ctime.
        // Bind the complete path and handle stamps before reading any bytes.
        stamp = sourceFileStamp(await lstat(file));
        if (!opened.isFile() || opened.nlink !== 1 || ["dev", "ino", "birthtimeMs", "size", "mtimeMs"].some(key => opened[key] !== info[key])
            || openedStamp !== stamp || process.platform !== "win32" && sourceFileStamp(info) !== stamp) throw changed("before reading");
        bytes = Buffer.alloc(info.size);
        const read = await handle.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead !== bytes.length || sourceFileStamp(await handle.stat()) !== openedStamp) throw changed("while reading");
        if (sourceFileStamp(await lstat(file)) !== stamp) throw changed("at its saved path");
    } finally { await handle.close(); }
    const checkpoint = JSON.parse(bytes);
    validateReferenceCheckpoint(checkpoint, { index, sourceSessionId: sourceId });
    if (!same(row.cursor, checkpoint.cursor) || !contextFits(checkpoint.events)) return null;
    const backfill = await loadBackfillCheckpoint(root);
    const prefix = backfill?.checkpoint.backfillSource === sourceId ? backfill.checkpoint.events : [];
    const indexFile = path.join(root, "index.json"), indexStamp = sourceFileStamp(await lstat(indexFile));
    const prefixStamp = backfill && sourceFileStamp(await lstat(backfill.file));
    const assertCurrent = () => {
        if (sourceFileStamp(lstatSync(file)) !== stamp || sourceFileStamp(lstatSync(indexFile)) !== indexStamp
            || backfill && sourceFileStamp(lstatSync(backfill.file)) !== prefixStamp) throw changed("before publication");
    };
    return { events: [...checkpoint.events, ...prefix], cursor: checkpoint.cursor, assertCurrent,
        selectedBackfill: backfill?.checkpoint.backfill.sources.some(row => row.sessionId === sourceId && ["pending", "reading"].includes(row.phase)) === true,
        proof: [hash(bytes), backfill?.hash ?? null] };
}

export function sourceCorrections({ state, source, scope, context }) {
    const sourceId = source.sessionId, managed = new Set(source.managedWorkIqEventIds ?? []);
    const retained = (state.evidence ?? []).filter(r => r.sourceSessionId === sourceId);
    const calls = new Map(), byStart = new Set(), duplicateStarts = new Set();
    for (const record of retained) for (const call of record.toolCalls ?? []) {
        if (byStart.has(call.startEventId)) duplicateStarts.add(call.startEventId);
        byStart.add(call.startEventId);
        if (calls.has(call.toolCallId)) { calls.set(call.toolCallId, null); continue; }
        calls.set(call.toolCallId, { record, call, starts: 0, ends: 0 });
    }
    for (const [id, t] of calls) if (!t || !id || !t.call.startEventId || duplicateStarts.has(t.call.startEventId)
        || t.record.sample || t.record.synthetic || t.record.isLegacy || t.record.sourceHost !== "copilot-app"
        || t.record.workloadKind !== "recorded-history" || !t.call.startedAt
        || t.call.startedAt < scope.since || t.call.startedAt > scope.until
        || !(isIncompleteWorkIqCall(t.call) || t.call.completionEventId
            && (t.call.resultEvidence == null || t.call.toolSucceeded === false && t.call.failureEvidence == null))) calls.delete(id);
    const uncovered = new Set();
    const dependencies = (call, next) => {
        for (const e of context.events.filter(event => event.data?.toolCallId === call.toolCallId
            || event.id === call.startEventId || event.id === next.completionEventId)) {
            if (e.type === "tool.execution_start") {
                if (e.id !== call.startEventId || e.timestamp !== call.startedAt || e.data.toolCallId !== call.toolCallId
                    || !same(e.data.arguments, call.requestArgs)) return false;
            } else if (e.type === "tool.execution_complete") {
                if (hasCompletionReference(e) || e.id !== next.completionEventId || e.timestamp !== next.completedAt
                    || e.data.toolCallId !== next.toolCallId) return false;
                const cached = completeWorkIqCall({ startedAt: call.startedAt }, e, undefined, true);
                if (!["toolSucceeded", "apiResults", "resultEvidence", "failureEvidence"].every(k => same(cached[k], next[k]))) return false;
            } else return false;
        }
        return true;
    };
    return {
        async observe(tail, file, budget, access, retainedEnd) {
            let extra = 0;
            for (const item of [...tail.recovery.original, ...tail.recovery.projected]) {
                const e = item.event, d = e.data, t = calls.get(d?.toolCallId);
                if (!t) continue;
                if (e.type === "tool.execution_start") {
                    t.starts++; t.startOffset = item.offset;
                    t.start = !item.sha256 && filterDeletedEvents([e], sourceId, state.deletion).length === 1
                        && e.id === t.call.startEventId && e.timestamp === t.call.startedAt
                        && isWorkIqTool({ ...d, wireManagedWorkIq: managed.has(e.id) })
                        && t.call.tool === `workiq-${d.mcpToolName ?? d.toolName?.replace(/^workiq-/, "")}`
                        && same(d.arguments, t.call.requestArgs) && (d.turnId ?? null) === t.call.turnId
                        && (d.parentToolCallId ?? null) === t.call.parentToolCallId
                        && !textFindings(JSON.stringify(d.arguments ?? {})).some(v => v.mandatory);
                } else if (e.type === "tool.execution_complete") {
                    t.ends++; t.endOffset = item.offset;
                    if (!context || context.cursor.identity !== tail.cursor.identity || item.endOffset > context.cursor.offset
                        || e.timestamp < t.call.startedAt || e.timestamp > scope.until
                        || !filterDeletedEvents([e], sourceId, state.deletion).length) continue;
                    if (!item.sha256 && t.call.completionEventId === e.id && t.call.completedAt === e.timestamp
                        && typeof d.success === "boolean" && d.success === t.call.toolSucceeded
                        && t.call.reportedOutcome === (d.success ? "succeeded" : "failed")) {
                        const compact = retainedEnd(e);
                        if (!compact || textFindings(JSON.stringify(compact)).some(v => v.mandatory)) continue;
                        const facts = completeWorkIqCall({ startedAt: t.call.startedAt }, compact, undefined, true);
                        if (!same(facts.apiResults, t.call.apiResults)
                            || t.call.failureEvidence && !same(t.call.failureEvidence, facts.failureEvidence)
                            || t.call.resultEvidence && !same(t.call.resultEvidence, facts.resultEvidence)) continue;
                        const additions = {};
                        if (t.call.resultEvidence == null && facts.resultEvidence) additions.resultEvidence = facts.resultEvidence;
                        if (t.call.failureEvidence == null && facts.failureEvidence?.diagnostic?.status === "recorded") additions.failureEvidence = facts.failureEvidence;
                        if (Object.keys(additions).length) { t.next = { ...t.call, ...additions }; t.kind = "metadata"; }
                    } else if (item.sha256 && !tail.cursor.droppedBytes && isIncompleteWorkIqCall(t.call)) {
                        const opts = { sourceSessionId: sourceId, since: scope.since, until: scope.until, records: retained,
                            deletion: state.deletion, completionOffsets: new Set([item.offset]) };
                        let match = recoverSameReadCompletions({ ...tail.recovery, ...opts });
                        if (match.dispositions[0]?.reason === "ambiguous-or-missing-match"
                            && !tail.recovery.original.some(entry => entry.event.type === "tool.execution_start" && entry.event.data.toolCallId === d.toolCallId)
                            && budget - extra >= TAIL_LIMITS.chunkBytes) {
                            await access.verify();
                            const fresh = await readCompletionLookbehind(file, sourceId, item, tail.recovery, budget - extra);
                            extra += fresh.bytesRead;
                            if (fresh.recovery && fresh.recovery.readStart >= tail.cursor.droppedBytes) {
                                const seen = [...fresh.recovery.original, ...fresh.recovery.projected];
                                const ids = new Set(seen.map(x => x.event.id));
                                const invocations = new Set(seen.filter(x => ["hook.start", "hook.end"].includes(x.event.type))
                                    .map(x => x.event.data.hookInvocationId));
                                const outside = [...tail.recovery.original, ...tail.recovery.projected]
                                    .filter(entry => entry.offset < fresh.recovery.readStart || entry.endOffset > fresh.recovery.readEnd);
                                if (!outside.some(({ event }) => ids.has(event.id)
                                    || ["hook.start", "hook.end"].includes(event.type) && invocations.has(event.data.hookInvocationId)
                                    || ["tool.execution_start", "tool.execution_complete"].includes(event.type) && event.data.toolCallId === d.toolCallId)) {
                                    match = recoverSameReadCompletions({ ...fresh.recovery, ...opts });
                                }
                            }
                        }
                        if (match.dispositions[0]?.status === "recovered") {
                            t.next = match.records.find(r => r.scenarioId === t.record.scenarioId).toolCalls.find(c => c.toolCallId === d.toolCallId);
                            t.kind = "completion";
                        }
                    }
                }
            }
            return extra;
        },
        finish(cursor) {
            const changes = [];
            let checkpointConflicts = 0;
            for (const t of calls.values()) {
                if (!cursor || !t.next || !context || !t.start || t.starts !== 1 || t.ends !== 1 || t.startOffset >= t.endOffset
                    || cursor?.backlogBytes || cursor?.droppedBytes || cursor?.malformedLines
                    || !filterDeletedRecords([t.record], state.deletion)[0]?.toolCalls?.some(c => same(c, t.call))) {
                    uncovered.add(t.call.toolCallId); continue;
                }
                if (!dependencies(t.call, t.next)) { uncovered.add(t.call.toolCallId); checkpointConflicts++; continue; }
                changes.push({ scenarioId: t.record.scenarioId, toolCallId: t.call.toolCallId, before: hash(JSON.stringify(t.call)),
                    next: t.next, kind: t.kind });
            }
            return { changes, unresolved: uncovered.size, checkpointConflicts };
        },
    };
}
