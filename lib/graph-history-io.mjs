import { open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { extractGraphActivities, assertSourceSession } from "./graph-history.mjs";
import { textFindings } from "./privacy.mjs";

function positive(value, fallback, maximum) {
    const n = value ?? fallback;
    if (!Number.isSafeInteger(n) || n < 1 || n > maximum) throw new TypeError("Invalid scanner bound.");
    return n;
}

export function completionResult(result, maxTextChars = 256000) {
    const blocks = Array.isArray(result?.content) ? result.content.filter(c => c?.type === "text" && typeof c.text === "string") : [];
    const text = typeof result?.content === "string" ? result.content
        : blocks.length ? blocks.map(c => c.text).join("\n") : typeof result === "string" ? result : "";
    let structured = result?.structuredContent;
    let textStructured;
    let payload = text.length > maxTextChars
        || /(?:^|\n)\s*(?:[{[]|```)|"[^"\r\n]+"\s*:/.test(text);
    if (text && text.length <= maxTextChars && blocks.length <= 1) {
        try { textStructured = JSON.parse(text); structured ??= textStructured; payload = true; }
        catch { /* Malformed or incomplete payloads remain payloads, never raw display lines. */ }
    }
    return { structured, text, payload, textStructured };
}

export function completionMetadata(event, maxTextChars = 256000) {
    const { structured, text, payload, textStructured } = completionResult(event.data?.result, maxTextChars);
    const status = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
    const numericStatuses = new Set([structured?.httpStatus, structured?.statusCode, textStructured?.httpStatus, textStructured?.statusCode]
        .map(status).filter(value => value !== undefined));
    const lines = [];
    if (text.length <= maxTextChars) {
        // Retain fixed provenance blockers, not the source line that contained them.
        for (const [pattern, marker] of [[/diff --git|^\s*(?:@@|\+\+\+|---)/m, "diff --git"],
            [/\b(?:testTransport|mockFetch|fixture)\b/i, "fixture"]]) {
            if (pattern.test(text)) lines.push(marker);
        }
        if (textFindings(text).some(finding => finding.mandatory)) lines.push("[Credential-bearing output excluded]");
        if (!payload) {
            const statuses = text.matchAll(/(?:HTTP\/(?:1\.[01]|2(?:\.0)?|3(?:\.0)?)\s+|(?:http[_ -]?status|status[_ -]?code|statusCode|status_code)\s*["']?\s*[:=]\s*["']?)([1-5]\d{2})\b/gi);
            for (const match of statuses) {
                numericStatuses.add(Number(match[1]));
                if (numericStatuses.size >= 40) break;
            }
        }
    }
    for (const value of numericStatuses) {
        if (lines.length >= 40) break;
        lines.push(`statusCode: ${value}`);
    }
    return {
        ...event, data: {
            toolCallId: event.data?.toolCallId, success: event.data?.success,
            result: { content: lines.join("\n"), structuredContent: { httpStatus: status(structured?.httpStatus), statusCode: status(structured?.statusCode) } },
        },
    };
}

/**
 * Reads only explicit roster-mapped events.jsonl paths. Does not discover credentials,
 * execute commands, follow script paths, or access source response bodies.
 */
export async function scanRecordedGraphHistory(options) {
    const { sources, sessionRoot, since, until } = options;
    if (!Array.isArray(sources) || !path.isAbsolute(sessionRoot)) throw new TypeError("Explicit sources and an absolute approved sessionRoot are required.");
    if (!Number.isFinite(Date.parse(since)) || !Number.isFinite(Date.parse(until)) || Date.parse(since) > Date.parse(until)) throw new TypeError("A valid bounded scan window is required.");
    const maxSessions = positive(options.maxSessions, 500, 1000);
    const maxFileBytes = positive(options.maxFileBytes, 384 * 1024 ** 2, 512 * 1024 ** 2);
    const maxTotalBytes = positive(options.maxTotalBytes, 8 * 1024 ** 3, 16 * 1024 ** 3);
    const maxLineBytes = positive(options.maxLineBytes, 8 * 1024 ** 2, 16 * 1024 ** 2);
    const maxTextChars = positive(options.maxTextChars, 256000, 4 * 1024 ** 2);
    if (sources.length > maxSessions) throw new RangeError("Source count exceeds scan bound.");
    const scenarios = [];
    const roster = [];
    const exclusions = {};
    const seen = new Set();
    let bytes = 0;
    const add = (name, n = 1) => { exclusions[name] = (exclusions[name] ?? 0) + n; };
    for (const source of sources) {
        assertSourceSession(source);
        if (seen.has(source.sessionId)) { add("duplicate-source"); continue; }
        seen.add(source.sessionId);
        const row = { sessionId: source.sessionId, appId: source.appId ?? null, projectId: source.projectId ?? null, archiveCheckedAt: source.checkedAt ?? null, scanned: false };
        roster.push(row);
        if (bytes >= maxTotalBytes) { row.disposition = "total-byte-bound"; add(row.disposition); continue; }
        const filename = path.join(sessionRoot, source.sessionId, "events.jsonl");
        let handle;
        try { handle = await open(filename, "r"); }
        catch (error) {
            row.disposition = error.code === "ENOENT" ? "missing-history" : "history-read-failed";
            row.errorCode = error.code ?? "unknown"; add(row.disposition); continue;
        }
        let length;
        let offset;
        try {
            const { size } = await handle.stat();
            const prefix = Buffer.alloc(Math.min(size, 65536));
            await handle.read(prefix, 0, prefix.length, 0);
            let startup;
            try { startup = JSON.parse(prefix.toString("utf8").split("\n")[0]); }
            catch { row.disposition = "invalid-startup"; add(row.disposition); continue; }
            if (startup.type !== "session.start" || startup.data?.sessionId !== source.sessionId) { row.disposition = "startup-mismatch"; add(row.disposition); continue; }
            length = Math.min(size, maxFileBytes, maxTotalBytes - bytes);
            offset = size - length; bytes += length;
            row.bytesRead = length; row.truncated = offset > 0;
            if (row.truncated) add("truncated-source");
        } finally { await handle.close(); }
        if (!length) { row.disposition = "empty-history"; add(row.disposition); continue; }
        const events = [];
        const lines = createInterface({ input: createReadStream(filename, { start: offset, end: offset + length - 1 }), crlfDelay: Infinity });
        let first = true;
        for await (const line of lines) {
            if (first && offset > 0) { first = false; continue; }
            first = false;
            if (!line.trim()) continue;
            if (Buffer.byteLength(line) > maxLineBytes) { add("oversized-event"); continue; }
            if (!/"type"\s*:\s*"(?:user\.message|assistant\.message|tool\.execution_start|tool\.execution_complete|subagent\.started)"/.test(line)) continue;
            let event;
            try { event = JSON.parse(line); } catch { add("malformed-event"); continue; }
            if (!event.timestamp || event.timestamp > until) continue;
            if (event.timestamp < since && event.type !== "user.message") continue;
            if (event.type === "tool.execution_complete") event = completionMetadata(event, maxTextChars);
            if (event.type === "assistant.message") {
                const text = event.data?.content;
                if (typeof text !== "string" || text.length > maxTextChars || !/fallback|falling back|instead|switch/i.test(text)) continue;
            }
            if (events.length >= 100000) { add("source-event-bound"); break; }
            events.push(event);
        }
        const result = extractGraphActivities(events, source, { since, until, maxEvents: 100000, maxTextChars });
        for (const [name, count] of Object.entries(result.exclusions)) add(name, count);
        row.scanned = true; row.disposition = "scanned"; row.graphActivities = result.coverage.graphActivities;
        row.nestedAgentLaunches = result.coverage.nestedAgentLaunches;
        scenarios.push(...result.scenarios);
    }
    const activities = scenarios.flatMap((s) => s.graphActivities);
    return {
        schemaVersion: 1, since, until, scannedAt: new Date().toISOString(), scenarios,
        coverage: {
            sourcesRequested: sources.length, sourcesScanned: roster.filter((r) => r.scanned).length,
            byteCount: bytes, graphActivities: activities.length,
            requestedDirectSites: activities.filter((a) => !a.synthetic && a.evidenceLevel !== "code-reference").length,
            outputVisibleStatuses: activities.filter((a) => !a.synthetic && a.evidenceLevel === "output-visible-http").length,
            codeReferences: activities.filter((a) => !a.synthetic && a.evidenceLevel === "code-reference").length,
            syntheticReferences: activities.filter((a) => a.synthetic).length,
            nestedAgentLaunches: roster.reduce((n, r) => n + (r.nestedAgentLaunches ?? 0), 0),
        },
        roster, exclusions,
        limits: { maxSessions, maxFileBytes, maxTotalBytes, maxLineBytes, maxTextChars },
        notes: [
            "Scanned explicit eligible inventory mappings only; archive status is the roster's checked-at snapshot.",
            "A recorded direct request is not proof of network dispatch or a measured HTTP call count.",
            "Source code, tests, Git diffs and source reads do not establish Graph execution.",
            "Referenced script source is considered only when a full Add File snapshot and an invocation are present in the same log; dynamic imports and external script bodies are not followed.",
            "Only nested agent tool events present in the approved source stream are eligible; a child summary or launch alone does not expose child HTTP traffic.",
            "Commands and entity responses were never executed or replayed. Original prompt text is private; activity rows contain only normalized metadata and source references.",
        ],
    };
}

/** Merge prompt groups, preserving the existing Work IQ/HTTP evidence and review identities. */
export function mergeGraphScenarios(existing, graphScenarios, { scannedSessionIds } = {}) {
    const replaceSources = new Set(scannedSessionIds ?? graphScenarios.map((s) => s.sourceSessionId));
    const groups = new Map(existing.map((s) => [s.scenarioId, { ...s, graphActivities: replaceSources.has(s.sourceSessionId) ? [] : s.graphActivities ?? [] }]));
    for (const added of graphScenarios) {
        const previous = groups.get(added.scenarioId);
        if (previous) groups.set(added.scenarioId, { ...previous, graphActivities: added.graphActivities });
        else groups.set(added.scenarioId, added);
    }
    return [...groups.values()];
}
