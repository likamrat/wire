import { projectNativeReadModel, projectNativeRetainedObservations, projectNativeRetainedEntries, NativeReadModelError } from "./native-read-model.mjs";

export function retainedSourceIds() {
    return ["github-copilot", "microsoft-365-chat", "microsoft-365-cowork"];
}
const nativeRecords = new WeakSet();
const key = (...parts) => JSON.stringify(parts);
const nativeSource = surface => `microsoft-365-${surface}`;
const outcome = state => ({ succeeded: "success", failed: "failure" })[state] ?? "unknown";
const unavailableEndpoint = Object.freeze({
    id: "native:path-unqualified", label: "Path not qualified", path: null, method: null, apiVersion: null, queryShape: [],
});

export function isNativeConsumerRecord(record) {
    return record?.recordKind === "native-conversation";
}

export function retainedSourceId(record) {
    if (isNativeConsumerRecord(record)) {
        if (!nativeRecords.has(record)) throw new NativeReadModelError("untrusted-native-consumer-record", "$");
        return nativeSource(record.nativeConversation.scope.surface);
    }
    return ["copilot-app", "copilot-app-chat"].includes(record?.sourceHost) ? "github-copilot" : null;
}

export function projectRetainedNativeRecords(envelopes) {
    const model = Array.isArray(envelopes) ? projectNativeReadModel(envelopes) : projectNativeRetainedObservations(envelopes);
    return consumerRecords(model);
}

export function projectRetainedNativeEntries(value) {
    return consumerRecords(projectNativeRetainedEntries(value));
}

function consumerRecords(model) {
    const records = model.conversations.map(conversation => {
        for (const result of conversation.returnedResults) {
            if (new Set(result.observed.map(row => row.index)).size !== result.observed.length) {
                throw new NativeReadModelError("duplicate-native-result-position", "$.returnedResults");
            }
        }
        const record = {
            recordKind: "native-conversation", scenarioId: conversation.key, sourceSessionId: conversation.key,
            sourceId: nativeSource(conversation.scope.surface), sourceHost: conversation.scope.harness,
            sourceSessionName: conversation.scope.surface === "chat" ? "Microsoft 365 Chat" : "Microsoft 365 Cowork",
            nativeConversation: conversation,
        };
        nativeRecords.add(record);
        return record;
    });
    return { records, definitions: model.definitions, admission: model.admission,
        ...(model.readback ? { readback: model.readback } : {}) };
}

function conversationRow(record, layer) {
    const conversation = record.nativeConversation;
    return {
        scenarioId: record.scenarioId, scenarioIds: [record.scenarioId],
        sourceSessionId: record.sourceSessionId, sourceId: retainedSourceId(record),
        sourceScope: conversation.scope, projectId: null, scope: "history",
        startedAt: null, durationMs: null, promptAuthor: "unknown",
        workload: "Unknown", endpoint: unavailableEndpoint, targetCount: 0, targets: [],
        serviceAssociation: { layer, services: [], status: "missing", basis: "unqualified-native-target",
            gaps: [{ reason: "native-target-unqualified", label: "Service not qualified",
                description: "The retained native contract does not qualify a service target. Native tool names are not service evidence." }] },
        activityType: "native-tool", evidenceLevel: "native-source-observation", archiveVerified: false,
    };
}

export function nativeMessageCreationInstants(record) {
    const conversation = record.nativeConversation;
    if (conversation.scope.surface !== "chat") return [];
    const originalTypes = new Map((conversation.sourceObservations ?? []).map(group =>
        [group.observationKey, group.identity.messageType]));
    return conversation.observations.flatMap(observation => {
        const type = originalTypes.get(observation.observationKey);
        const ordinary = type?.availability === "absent-in-response"
            || type?.availability === "recorded" && type.value === "Chat";
        const created = observation.fields.messageCreatedAt;
        return ordinary && created?.availability === "recorded" && created.calendarInstant ? [created.calendarInstant] : [];
    });
}

export function nativeObservationInstant(observation) {
    const fact = observation?.fields?.observationTime;
    return fact?.availability === "recorded" ? fact.calendarInstant ?? null : null;
}

function callStartInstant(call) {
    const starts = call.observations.filter(observation => observation.identity.nativeType === "ts"
        && observation.retention?.current !== false);
    const instants = new Set(starts.map(nativeObservationInstant));
    return instants.size === 1 ? [...instants][0] : null;
}

export function nativeActivityRows(records, layer) {
    return records.filter(isNativeConsumerRecord).flatMap(record => {
        const base = conversationRow(record, layer), conversation = record.nativeConversation;
        if (layer === "tool") return conversation.calls.map(call => ({
            ...base, id: call.key, toolCallId: call.nativeCallId, tool: call.nativeToolNames.length === 1 ? call.nativeToolNames[0] : null,
            startedAt: callStartInstant(call),
            nativeToolNames: call.nativeToolNames, nativeOutcome: call.outcome, nativeConflicts: call.conflicts,
            outcome: outcome(call.outcome.state), status: null, countUnit: "native-tool-call",
            identityBasis: "native-source-account-conversation-call",
        }));
        if (layer !== "reported-api") return [];
        return conversation.returnedResults.flatMap(result => {
            return result.observed.map(row => {
                const call = result.callKeys.length === 1 ? conversation.calls.find(call => call.key === result.callKeys[0]) : null;
                return {
                    ...base, id: key("native-returned-result", result.observationKey, row.index),
                    startedAt: nativeObservationInstant(conversation.observations.find(observation => observation.observationKey === result.observationKey)),
                    parentCallId: call?.key ?? null, toolCallId: call?.nativeCallId ?? null,
                    tool: call?.nativeToolNames.length === 1 ? call.nativeToolNames[0] : null,
                    nativeToolNames: call?.nativeToolNames ?? [], observationKey: result.observationKey,
                    resultIndex: row.index, status: row.statusCode, errorCode: row.errorCode,
                    outcome: row.statusCode === null ? row.errorCode ? "failure" : "unknown"
                        : row.statusCode >= 200 && row.statusCode < 300 ? "success" : row.statusCode >= 400 ? "failure" : "other",
                    countUnit: "native-returned-result-observation", identityBasis: "native-observation-response-position",
                    evidenceLevel: row.evidenceLevel,
                };
            });
        });
    });
}

// Context uses the same selection predicate, never fabricated measured call rows.
export function retainedSelection(records, rows, filters, projection, layer) {
    const { selected } = projection;
    const selectedIds = new Set(rows.map(row => row.scenarioId));
    const contextOnly = new Set();
    const dateBounded = Boolean(filters.from || filters.to);
    const messageDates = new Set();
    const callFilters = ["tools", "outcomes", "services", "workloads", "endpoints", "activityTypes"];
    for (const record of records.filter(isNativeConsumerRecord)) {
        if (layer !== "tool" || callFilters.some(name => filters[name]?.length)) continue;
        const base = conversationRow(record, layer), dates = nativeMessageCreationInstants(record);
        const dateRows = dates.map(startedAt => ({ ...base, startedAt }));
        if (dateRows.some(row => selected(row, { ...filters, from: undefined, to: undefined }))) messageDates.add(record.scenarioId);
        const eligible = dateBounded ? dateRows.some(row => selected(row, filters))
            : !record.nativeConversation.calls.length && selected(base, filters);
        if (eligible && !selectedIds.has(record.scenarioId)) {
            selectedIds.add(record.scenarioId);
            if (dateBounded) contextOnly.add(record.scenarioId);
        }
    }
    const scenarioIds = records.filter(record => typeof record.scenarioId === "string" && record.scenarioId
        && selectedIds.has(record.scenarioId)).map(record => record.scenarioId);
    const retainedIds = new Set(scenarioIds);
    const native = records.filter(record => isNativeConsumerRecord(record) && retainedIds.has(record.scenarioId));
    const conversationKeys = native.map(record => record.scenarioId);
    const messageCreationDateScenarioIds = [...messageDates].filter(id => selectedIds.has(id));
    const population = {
        scenarioIds,
        contextOnlyScenarioIds: [...contextOnly],
        contextDateBasis: dateBounded ? "ordinary-message-created" : null,
        nativeConversationKeys: conversationKeys,
        rowIds: rows.map(row => row.id),
        rowScenarioIds: rows.map(row => row.scenarioId ?? null),
        rowUnits: rows.map(row => row.countUnit ?? (layer === "tool" ? "github-tool-call" : layer)),
        units: [...new Set(rows.map(row => row.countUnit ?? (layer === "tool" ? "github-tool-call" : layer)))],
        coverage: {
            unknownSourceScenarioIds: records.filter(record => retainedIds.has(record.scenarioId) && retainedSourceId(record) === null).map(record => record.scenarioId),
            nativeActivityDates: rows.some(row => row.countUnit?.startsWith("native-") && row.startedAt)
                ? "source-observation-qualified" : "unqualified",
            messageCreationDateScenarioIds, messageCreationDatesAvailable: messageCreationDateScenarioIds.length > 0,
            nativeServices: "unqualified",
            nativeResponseLatency: "unsupported",
            nativeMessages: "representation-observations-not-unique-turns",
            nativeReports: "native-report-provenance-unqualified",
        },
    };
    return projection.narrowPopulation(population, population.scenarioIds, rows, records);
}

export function nativeReportSelection(records, analytics) {
    const population = analytics.population;
    const selected = new Set(population.nativeConversationKeys);
    return {
        status: "withheld", code: "native-report-provenance-unqualified",
        conversationKeys: [...selected],
        // These are preparation facts, never a frozen report or authority manifest.
        facts: records.filter(record => isNativeConsumerRecord(record) && selected.has(record.scenarioId))
            .map(record => ({ scope: record.nativeConversation.scope, conversationKey: record.scenarioId,
                selectedRows: analytics.rows.filter(row => row.scenarioId === record.scenarioId),
                contextUnit: "conversation-observations-not-selected-call-denominator",
                context: { taskOutcomes: record.nativeConversation.taskOutcomes,
                    resultReferences: record.nativeConversation.resultReferences, measurements: record.nativeConversation.measurements },
                coverage: record.nativeConversation.coverage })),
    };
}
