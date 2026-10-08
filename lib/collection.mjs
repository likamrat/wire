import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { scanHistory } from "./history.mjs";
import { createGraphRecorder, METADATA_URL } from "./graph.mjs";
import { replaceEvidence, resolveDataDir, writeExclusive, BoardError } from "./store.mjs";
import { scanRecordedGraphHistory, mergeGraphScenarios } from "./graph-history-io.mjs";
import { validateGraphActivity } from "./graph-history.mjs";
import { collectorFor } from "./collector.mjs";
import { chatCopy } from "./chat-copy.mjs";

function graphCoverage(imported) {
    const { scenarios, mergedScenarios, ...metadata } = imported;
    return metadata;
}

export async function applyGraphImport(session, imported) {
    if (!Array.isArray(imported.scenarios) || !Array.isArray(imported.roster) || !imported.coverage) {
        throw new BoardError("Graph history import is incomplete.", 422);
    }
    for (const scenario of imported.scenarios) {
        if (!Array.isArray(scenario.graphActivities)) throw new BoardError("Graph history scenario is incomplete.", 422);
        for (const activity of scenario.graphActivities) validateGraphActivity(activity);
    }
    return (await replaceEvidence(session, (current, importCoverage) => ({
        records: mergeGraphScenarios(current, imported.scenarios, { scannedSessionIds: imported.roster.filter((row) => row.scanned).map((row) => row.sessionId) }),
        importCoverage: { ...importCoverage, graphHistory: graphCoverage(imported) },
    }))).state;
}

const scans = new Map();
export function refreshHistory(session) {
    const collector = collectorFor(session);
    if (collector) return collector.collectNow().then(() => import("./store.mjs")).then(({ loadBoardState }) => loadBoardState(session));
    const dataDir = resolveDataDir(session);
    if (scans.has(dataDir)) return scans.get(dataDir);
    const operation = (async () => {
        const files = path.join(dataDir, "import");
        const config = JSON.parse(await readFile(path.join(files, "history-window.json"), "utf8"));
        if (!path.isAbsolute(config.sessionRoot ?? "") || !path.isAbsolute(config.appDbPath ?? "")) {
            throw new BoardError("History import requires an approved absolute chat log root (sessionRoot) and app database path.", 422);
        }
        const until = config.windowDays ? new Date().toISOString() : config.until;
        const since = config.windowDays ? new Date(Date.parse(until) - config.windowDays * 86400000).toISOString() : config.since;
        if (config.windowDays && (!Number.isInteger(config.windowDays) || config.windowDays < 1 || config.windowDays > 90)) throw new Error("History window must be bounded to 1-90 days.");
        const imported = await scanHistory({
            inventoryPath: path.join(files, "app-inventory.json"), appDbPath: config.appDbPath,
            sessionRoot: config.sessionRoot, since, until,
        });
        const graph = await scanRecordedGraphHistory({
            sources: imported.roster.filter((row) => row.eligible),
            sessionRoot: config.sessionRoot, since, until,
        });
        const eligibleSources = new Set(imported.roster.filter((row) => row.eligible).map((row) => row.sessionId));
        const coverage = { ...imported, inventoryCapturedAt: config.inventoryCapturedAt, scenarios: undefined, graphHistory: graphCoverage(graph) };
        const committed = await replaceEvidence(session, (current) => ({
            records: mergeGraphScenarios(
                [...current.filter((s) => s.isLegacy || s.evidenceLayer === "direct-graph-http"),
                    ...current.filter((s) => !s.isLegacy && s.graphActivities?.length && eligibleSources.has(s.sourceSessionId)).map((s) => ({ ...s, toolCalls: [] })),
                    ...imported.scenarios.map((scenario) => ({
                        ...scenario,
                        graphActivities: current.find((prior) => prior.scenarioId === scenario.scenarioId)?.graphActivities ?? [],
                    }))],
                graph.scenarios,
                { scannedSessionIds: graph.roster.filter((row) => row.scanned).map((row) => row.sessionId) },
            ),
            importCoverage: coverage,
        }));
        return committed.state;
    })();
    scans.set(dataDir, operation);
    operation.then(() => scans.delete(dataDir), () => scans.delete(dataDir));
    return operation;
}

export async function addGraphRecord(session, record, userPrompt = { status: "unavailable", provenance: "ui-action", text: null }) {
    if (record.synthetic || record.classification !== "direct-graph-http") throw new BoardError("Synthetic records cannot enter real board coverage.");
    const scenarioId = record.correlation.scenarioId ?? `graph-${record.recordId}`;
    const scenario = {
        scenarioId, title: "Direct Graph HTTP: public metadata", family: "reads_functions",
        sourceSessionId: record.correlation.sessionId, sourceSessionUrl: null,
        sourceHost: "copilot-app", project: "(unscoped recorder session)", projectId: null,
        sourceSessionName: "Work IQ Evidence Board recorder", capturedAt: record.startedAt,
        userPrompt, followUpPrompts: [], sample: false, workloadKind: "public-metadata-demonstration",
        promptAssociation: userPrompt.status === "full" ? "Explicit user-directed recorder demonstration; nearest source message retained. No workload tool-call relationship is inferred." : "Explicit recorder UI action; no textual prompt or historical tool-call relationship asserted.",
        toolCalls: [{
            tool: "owned-graph-http", order: 1, requestArgs: { method: record.requestedMethod ?? record.method, path: "/$metadata" },
            requestedApiPath: "/$metadata", reportedOutcome: record.status == null ? "unknown" : record.status >= 200 && record.status < 300 ? "succeeded" : "failed",
            toolSucceeded: record.status == null ? null : record.status >= 200 && record.status < 300,
            apiResults: [{ index: 0, statusCode: record.status, errorCode: null, evidenceLevel: record.observedGraphHttp ? "direct-http-observed" : "no-http-response" }],
            observedGraphHttp: record.observedGraphHttp, durationMs: record.durationMs,
            apiSurfaceNote: "Owned opt-in direct HTTP boundary; no tenant authentication or hosted Work IQ internal tracing.",
        }],
        httpRecords: [record], evidenceLayer: "direct-graph-http", taskCorrectness: "unknown",
        coverageNote: "Public metadata demonstration only, not authenticated workplace coverage. Duration ends at response headers. No response body, authorization or cookies logged; no retry.",
    };
    return (await replaceEvidence(session, (current, importCoverage) => ({
        records: [...current.filter((s) => s.scenarioId !== scenarioId), scenario], importCoverage,
    }))).state;
}

export async function recordMetadataResult(session, confirmed, { attemptId = randomUUID(), testTransport, timeoutMs = 30000 } = {}) {
    if (confirmed !== true) throw new BoardError("Explicit opt-in is required for the public Graph metadata GET.");
    const directory = path.join(resolveDataDir(session), "http-records");
    await mkdir(directory, { recursive: true });
    const scenarioId = `graph-${attemptId}`;
    let record, recordSaved = false, evidenceSaved = false, response;
    const recorder = createGraphRecorder({ enabled: true, testTransport, persist: async value => {
        record = value;
        await writeExclusive(path.join(directory, `${value.recordId}.json`), JSON.stringify(value, null, 2));
        recordSaved = true;
    } });
    try {
        const result = await recorder(METADATA_URL, { method: "GET", redirect: "error", headers: { Accept: "application/xml", "client-request-id": randomUUID() }, signal: AbortSignal.timeout(timeoutMs) },
            { sessionId: session.sessionId, scenarioId, toolCallId: null });
        response = result.response;
    } catch (error) {
        if (!error.record) throw error;
        record = error.record;
        response = error.response;
    }
    let cleanupFailed = false;
    try { await response?.body?.cancel(); }
    catch { cleanupFailed = true; }
    if (recordSaved && !record.synthetic) {
        try { await addGraphRecord(session, record); evidenceSaved = true; }
        catch (error) { console.error("[workiq-recorder] evidence indexing failed", { code: error.code ?? "PERSISTENCE" }); }
    }
    const phase = !recordSaved || !record.synthetic && !evidenceSaved ? "save-error"
        : record.status == null ? "no-response"
        : record.status < 200 || record.status >= 300 ? "http-error"
        : !record.synthetic && !record.observedGraphHttp ? "unverified-response" : "succeeded";
    return {
        phase, recordId: record.recordId, scenarioId, status: record.status, transportError: record.transportError,
        observedGraphHttp: record.observedGraphHttp, synthetic: record.synthetic,
        recordSaved, evidenceSaved, cleanupFailed,
    };
}

export async function recordMetadata(session, confirmed) {
    const result = await recordMetadataResult(session, confirmed);
    if (result.phase !== "succeeded") throw new BoardError(
        `Diagnostic ${result.phase}${result.status == null ? "" : ` (HTTP ${result.status})`}. ${result.recordSaved ? `Record ${result.recordId} saved in http-records.` : "Recorder file was not saved."} No automatic retry.`, 502);
    const { loadBoardState } = await import("./store.mjs");
    return loadBoardState(session);
}

export function coverageFor(state, scenarios) {
    const imported = state.importCoverage;
    const graph = imported?.graphHistory;
    const retainedScans = Boolean(imported?.dynamic) && !Array.isArray(graph?.roster);
    const realHttp = scenarios.flatMap((s) => s.httpRecords ?? []).filter((r) => !r.synthetic && r.observedGraphHttp);
    return {
        totalScenarios: scenarios.length,
        distinctSourceSessions: imported?.counts.includedSessions ?? 0,
        distinctProjects: imported?.counts.includedProjects ?? 0,
        unscopedSessions: imported?.roster.filter((r) => r.disposition === "included" && !r.projectId).length ?? 0,
        families: [...new Set(scenarios.filter((s) => !s.isLegacy).map((s) => s.family))],
        counts: imported?.counts ?? null, since: imported?.since, until: imported?.until, checkedAt: imported?.checkedAt,
        inventoryCapturedAt: imported?.inventoryCapturedAt,
        directHttpCount: realHttp.length, importedHistoricalHttpCount: graph?.coverage?.outputVisibleStatuses ?? 0,
        graphHistory: graph ? {
            since: graph.since, until: graph.until, scannedAt: graph.scannedAt,
            sourceCountBasis: retainedScans ? "retained-scan-history" : "single-scan",
            counts: graph.coverage, exclusions: graph.exclusions, limits: graph.limits,
        } : null,
        notes: [
            ...(imported?.dynamic?.historyCoverage?.unavailable ? [`${chatCopy.count(imported.dynamic.historyCoverage.unavailable)} had unreadable local saved history at this snapshot. Uncollected activity may be absent; previously collected evidence is kept. These are history gaps, not failed Work IQ or Graph requests.`] : []),
            "Coverage counts only archive-verified app-listed GitHub Copilot chats with real Work IQ executions in the bounded window; legacy cards and new HTTP demo are separate.",
            imported?.dynamic
                ? "Runtime collection discovers current app metadata every 30 seconds and tails approved mapped local logs at the selected cadence. Archived/nonlocal/unmapped sources are excluded from current activity; their previously captured evidence is preserved. No hosted Work IQ internal Graph traffic is visible."
                : "Historical imported snapshot. Connect a local Copilot source for dynamic discovery and incremental collection.",
            graph
                ? `Recorded Graph scan: ${graph.coverage.requestedDirectSites} direct request sites, ${graph.coverage.outputVisibleStatuses} output-visible statuses and ${graph.coverage.codeReferences} code references. Code references are not executions; requested paths are not observed HTTP.`
                : "Direct Graph history has not been scanned in this collection. Requested Graph-shaped paths are not observed HTTP.",
            "Direct HTTP records are opt-in public metadata demonstrations, not authenticated mailbox/workplace reads.",
            "Source roster reports truncated tails, malformed lines, missing completions, unmapped IDs and missing logs; coverage is not a complete history claim.",
            ...(graph ? [
                retainedScans
                    ? `${graph.coverage.sourcesScanned} listed sources have been read at least once, including sources no longer eligible; ${graph.coverage.sourcesRequested} sources are currently eligible. These are separate counts, not scan progress. ${graph.coverage.syntheticReferences} synthetic references excluded from real totals.`
                    : `${graph.coverage.sourcesScanned} sources have a recorded Graph scan; ${graph.coverage.sourcesRequested} sources were requested for scanning. ${graph.coverage.syntheticReferences} synthetic references excluded from real totals.`,
                ...Object.entries(graph.exclusions ?? {}).map(([reason, count]) => `Graph scan limitation: ${reason.replaceAll("-", " ")} (${count}).`),
                "Nested agent summaries and dynamic SDK/CLI targets do not establish hidden requests; only recorded source-stream evidence is inspected.",
            ] : []),
        ],
    };
}
