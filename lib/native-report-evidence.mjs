import { createHash } from "node:crypto";
import { BoardError } from "./store.mjs";
import { scanTree } from "./privacy.mjs";
import { reportContextRef } from "./report-context.mjs";
import { normalizeReportOptions } from "./prompt-projection.mjs";
import { projectNativeReportCopies } from "./native-report-copies.mjs";
import { nativeCopyCoverage } from "./native-report-copy-shape.mjs";
import { projectRetainedNativeRecords } from "./retained-population.mjs";
import { nativeRetentionHash } from "./native-retention-contract.mjs";
import { NATIVE_RETAINED_CONTRACT, nativeValueHasCredentials } from "./native-read-model.mjs";
import { NATIVE_RETENTION_POLICY_ID } from "./native-retention-state.mjs";
import { freezeEvaluationFacts } from "./report-facts.mjs";
import { nativeReportCoverage, nativeReportPopulations, nativeReportReferences, validateNativeReportEvidence } from "./native-report-shape.mjs";
export { nativeReportReferences, validateNativeReportEvidence, inspectNativeReportNamespace } from "./native-report-shape.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const require = condition => { if (!condition) throw new TypeError("Invalid native report source."); };
const shape = (value, keys) => require(value && Object.getPrototypeOf(value) === Object.prototype
    && keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).length === keys.length);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const unique = values => new Set(values).size === values.length;

// Revalidate the retained contract and derived relationships; this cannot mint
// the producer's branded capture, commit or saved-file authorization.
function validateSource(frame) {
    shape(frame, ["records", "source"]);
    shape(frame.source, ["schemaVersion", "contractVersion", "policy", "sourceSnapshotRef", "sourceRevisionRef",
        "configurationRevision", "privacyRevision", "deletionVersion", "definitions"]);
    require(frame.source.schemaVersion === 1 && frame.source.contractVersion === NATIVE_RETAINED_CONTRACT
        && frame.source.policy === NATIVE_RETENTION_POLICY_ID
        && digest(frame.source.sourceSnapshotRef) && digest(frame.source.sourceRevisionRef)
        && ["configurationRevision", "privacyRevision", "deletionVersion"].every(name => count(frame.source[name])));
    require(Array.isArray(frame.records) && unique(frame.records.map(record => record?.scenarioId)));
    require(!nativeValueHasCredentials(frame.records));
    const normalized = [], ordinals = new Map();
    for (const record of frame.records) {
        require(record?.recordKind === "native-conversation" && Array.isArray(record.nativeConversation?.observations));
        const conversation = record.nativeConversation;
        for (const observation of conversation.observations) {
            require(observation.retention && count(observation.inputOrdinal) && !ordinals.has(observation.observationKey));
            ordinals.set(observation.observationKey, observation.inputOrdinal);
            const { sourceKey, observationKey, inputOrdinal, capturedObservationKey, messagePartKeys, ...retained } = observation;
            const group = conversation.sourceObservations?.find(item => item.observationKey === observationKey);
            if (group) retained.chatSource = { schemaVersion: 1, parserProvenance: group.parserProvenance,
                source: group.source, identity: group.identity, limitations: group.decoderLimitations,
                observations: group.facts.map(({ key, decoderReadModel, ...fact }) =>
                    ({ ...fact, ...(decoderReadModel ? { readModel: decoderReadModel } : {}) })) };
            const parts = conversation.messages.filter(message => message.parentObservationKey === observationKey);
            if (parts.length) retained.messageParts = parts.map(({ sourceKey, observationKey, parentObservationKey,
                retention, unit, identityBasis, ...message }) => message);
            normalized.push(retained);
        }
    }
    const rebuilt = projectRetainedNativeRecords({ contractVersion: NATIVE_RETAINED_CONTRACT, records: normalized });
    for (const record of rebuilt.records) {
        for (const observation of [...record.nativeConversation.observations, ...record.nativeConversation.calls.flatMap(call => call.observations)]) {
            observation.inputOrdinal = ordinals.get(observation.observationKey);
        }
    }
    require(nativeRetentionHash(rebuilt.records) === nativeRetentionHash(frame.records));
    const definitions = frame.source.definitions;
    require(definitions && Object.getPrototypeOf(definitions) === Object.prototype
        && Object.values(definitions).every(value => typeof value === "string" && value.length > 0 && value.length <= 4000));
    return scanTree(frame);
}

export function projectNativeReportEvidence(frame, key, input = {}, { githubRecords = [], githubEvaluationFacts,
    contextOnlyScenarioIds = [] } = {}) {
    try {
        require(digest(key));
        const sourceScan = validateSource(frame), options = normalizeReportOptions(input);
        const ref = (kind, value) => reportContextRef(key, kind, value);
        require(frame.records.length > 0 || options.overrides.length === 0);
        const projectedCopies = frame.records.length ? projectNativeReportCopies(frame.records, key, options)
            : { copies: [], review: [], unavailableFacts: [], coverage: nativeCopyCoverage([]) };
        const conversations = frame.records.map(record => {
            const conversation = record.nativeConversation;
            const sourceGroups = new Map((conversation.sourceObservations ?? []).map(group => [group.observationKey, group]));
            return {
                ref: ref("scenario", record.scenarioId), sourceId: record.sourceId,
                observations: conversation.observations.map(observation => ({
                    ref: ref("native-observation", observation.observationKey),
                    sourceRef: ref("native-source", JSON.stringify([observation.sourceKey, observation.fields.message?.value?.representation ?? null])),
                    variantRef: ref("native-variant", observation.retention.variant), current: observation.retention.current,
                    captureCount: observation.retention.captureCount,
                    interpretationRef: ref("native-interpretation", JSON.stringify([observation.capture.parserVersion,
                        observation.capture.sourceSchema, sourceGroups.get(observation.observationKey)?.parserProvenance ?? null])),
                    completeness: observation.ordering.completeness,
                })),
                calls: conversation.calls.map(call => ({
                    ref: ref("native-call", call.key), observationRefs: call.observations.map(item => ref("native-observation", item.observationKey)),
                    names: [...call.nativeToolNames], outcome: call.outcome.state, qualification: call.outcome.qualification,
                    conflicts: [...call.conflicts], inputAvailability: call.observations.map(item => item.fields.input?.availability ?? "not-supplied"),
                })),
                results: conversation.returnedResults.flatMap(result => result.observed.map(row => ({
                    ref: ref("native-result", JSON.stringify([result.observationKey, row.index])),
                    observationRef: ref("native-observation", result.observationKey), callRefs: result.callKeys.map(id => ref("native-call", id)),
                    index: row.index, statusCode: row.statusCode, errorCode: row.errorCode,
                    paginationPresent: row.paginationPresent, evidenceLevel: row.evidenceLevel,
                }))),
                resultCoverage: conversation.returnedResults.map(result => ({
                    observationRef: ref("native-observation", result.observationKey), availability: result.availability,
                    declaredRequestCount: result.declaredRequestCount, declaredRequestCountIsSuccessDenominator: false,
                })),
                measurements: conversation.measurements.map(measurement => ({
                    observationRef: ref("native-observation", measurement.observationKey), availability: measurement.availability,
                    milliseconds: measurement.availability === "recorded" ? measurement.value : null,
                    unit: "ms", boundaryRef: measurement.boundary ? ref("native-boundary", measurement.boundary) : null,
                    basisRef: measurement.basis ? ref("native-basis", measurement.basis) : null,
                    comparableToUserResponseLatency: false,
                })),
                resultReferences: conversation.resultReferences.map(references => ({
                    observationRef: ref("native-observation", references.observationKey), availability: references.availability,
                    unit: "source-result-reference-entry",
                    cardinality: references.availability === "recorded" ? references.value.cardinality : null,
                    shapeCounts: references.availability === "recorded" ? structuredClone(references.value.itemFieldTypes) : null,
                })),
                messages: conversation.messages.map(message => ({
                    ref: ref("native-message", message.observationKey),
                    observationRef: ref("native-observation", message.parentObservationKey ?? message.observationKey),
                    unit: message.parentObservationKey ? "message-representation-part" : "message-representation-observation",
                    copyKey: ref("native-copy", JSON.stringify([record.scenarioId, message.observationKey])),
                })),
                taskStates: conversation.taskOutcomes.map(task => ({
                    ref: ref("native-task-state", task.observationKey), observationRef: ref("native-observation", task.observationKey), state: task.state,
                })),
                sourceFacts: (conversation.sourceObservations ?? []).flatMap(group => group.facts.map(fact => ({
                    ref: ref("native-fact", fact.key), observationRef: ref("native-observation", group.observationKey), kind: fact.kind,
                }))),
            };
        });
        require(Array.isArray(contextOnlyScenarioIds) && unique(contextOnlyScenarioIds)
            && contextOnlyScenarioIds.every(id => frame.records.some(record => record.scenarioId === id)));
        const nativeEvidence = {
            schemaVersion: frame.records.length ? 1 : 2,
            definition: { id: "wire-native-report", version: 1, retainedContract: NATIVE_RETAINED_CONTRACT,
                retentionPolicy: NATIVE_RETENTION_POLICY_ID, interpretationRef: ref("native-definition", nativeRetentionHash({
                    definitions: frame.source.definitions,
                    interpretations: [...new Set(conversations.flatMap(conversation => conversation.observations.map(observation => observation.interpretationRef)))].sort(),
                })) },
            source: { snapshotRef: ref("native-snapshot", frame.source.sourceSnapshotRef), revisionRef: ref("native-revision", frame.source.sourceRevisionRef) },
            selection: { conversationRefs: conversations.map(conversation => conversation.ref),
                observationRefs: conversations.flatMap(conversation => conversation.observations.map(observation => observation.ref)),
                contextOnlyRefs: contextOnlyScenarioIds.map(id => ref("scenario", id)) },
            populations: nativeReportPopulations(conversations, contextOnlyScenarioIds.map(id => ref("scenario", id))), conversations,
            disclosure: { promptMode: options.promptMode, recordedContext: options.recordedContext,
                copies: projectedCopies.copies, unavailableFacts: projectedCopies.unavailableFacts, coverage: projectedCopies.coverage },
            coverage: { ...nativeReportCoverage },
            ...(githubEvaluationFacts ? { githubEvaluationFacts: freezeEvaluationFacts(githubEvaluationFacts),
                githubEvaluationFactsHash: hash(freezeEvaluationFacts(githubEvaluationFacts)) } : {}),
        };
        const records = [...githubRecords, ...nativeReportReferences(nativeEvidence)];
        validateNativeReportEvidence(nativeEvidence, records);
        return { nativeEvidence, nativeEvidenceHash: hash(nativeEvidence), records, review: projectedCopies.review, sourceScan };
    } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        const failure = new BoardError("Native report evidence has unsupported source fields, relationships or disclosure metadata. Nothing was prepared.", 422);
        failure.cause = error;
        throw failure;
    }
}
