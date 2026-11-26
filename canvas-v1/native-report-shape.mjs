import { createHash } from "node:crypto";
import { scanTree } from "./privacy.mjs";
import { validateNativeReportCopies } from "./native-report-copy-shape.mjs";
import { NATIVE_RETENTION_POLICY_ID } from "./native-retention-state.mjs";
import { freezeEvaluationFacts, evaluationGeneratedHashes } from "./report-facts.mjs";

const NATIVE_RETAINED_CONTRACT = "m365-native-screened-observations-v1";
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const require = condition => { if (!condition) throw new TypeError("Invalid frozen native report evidence."); };
const shape = (value, keys, optional = []) => require(value && Object.getPrototypeOf(value) === Object.prototype
    && keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => keys.includes(key) || optional.includes(key)));
const reference = (value, kind) => typeof value === "string" && new RegExp(`^${kind}-[a-f0-9]{16}$`).test(value);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const unique = values => new Set(values).size === values.length;
const availability = ["recorded", "recorded-empty", "explicit-null", "absent-in-response", "excluded-by-policy",
    "credential-excluded", "unsupported", "unqualified", "conflicting"];
const factKinds = ["provider-progress", "native-invocation", "task", "task_step", "task_steps", "task_reasoning",
    "clarification", "confirmation", "trigger-plugin", "unsupported-task", "unsupported-trigger-extension", "unsupported-native-invocation"];
const units = [
    ["native-tool-call", "calls"], ["native-returned-result-observation", "results"],
    ["message-representation-observation", "messages"], ["message-representation-part", "parts"],
    ["native-task-state-observation", "taskStates"], ["chat-source-observation", "sourceFacts"],
];
export const nativeReportCoverage = Object.freeze({
    history: "selected-retained-evidence-not-complete-source-history",
    calls: "native-call-identities-not-observation-or-capture-counts",
    messages: "representation-observations-and-parts-not-unique-turns",
    taskStates: "observed-task-state-not-tool-success",
    inputAndResultBodies: "withheld",
    services: "unqualified",
    activityDates: "unqualified",
    responseLatency: "unsupported",
});
export function nativeReportPopulations(conversations, contextOnlyRefs = []) {
    const measured = conversations.filter(conversation => !contextOnlyRefs.includes(conversation.ref));
    return units.map(([unit, field]) => {
        const refs = measured.flatMap(conversation => field === "parts" || field === "messages"
            ? conversation.messages.filter(message => message.unit === unit).map(message => message.ref)
            : conversation[field].map(item => item.ref));
        return { unit, refs, count: refs.length };
    });
}

export function nativeReportReferences(evidence) {
    return evidence.conversations.map(conversation => ({
        recordKind: "native-conversation", projectionVersion: 4, scenarioId: conversation.ref, nativeEvidenceRef: conversation.ref,
    }));
}

export function validateNativeReportEvidence(value, records) {
    shape(value, ["schemaVersion", "definition", "source", "selection", "populations", "conversations", "disclosure", "coverage"],
        ["githubEvaluationFacts", "githubEvaluationFactsHash"]);
    require([1, 2].includes(value.schemaVersion));
    shape(value.definition, ["id", "version", "retainedContract", "retentionPolicy", "interpretationRef"]);
    require(value.definition.id === "wire-native-report" && value.definition.version === 1
        && value.definition.retainedContract === NATIVE_RETAINED_CONTRACT && value.definition.retentionPolicy === NATIVE_RETENTION_POLICY_ID
        && reference(value.definition.interpretationRef, "native-definition"));
    shape(value.source, ["snapshotRef", "revisionRef"]);
    require(reference(value.source.snapshotRef, "native-snapshot") && reference(value.source.revisionRef, "native-revision"));
    shape(value.selection, ["conversationRefs", "observationRefs", "contextOnlyRefs"]);
    require(Array.isArray(value.conversations) && (value.schemaVersion === 2 ? value.conversations.length === 0 : value.conversations.length > 0));
    const all = new Set(), claim = (ref, kind) => { require(reference(ref, kind) && !all.has(ref)); all.add(ref); };
    const sourceRefs = new Map(), sourceOwners = new Map(), variants = new Set(), currentSources = new Set();
    for (const conversation of value.conversations) {
        shape(conversation, ["ref", "sourceId", "observations", "calls", "results", "resultCoverage", "measurements", "resultReferences", "messages", "taskStates", "sourceFacts"]);
        claim(conversation.ref, "scenario");
        require(["microsoft-365-chat", "microsoft-365-cowork"].includes(conversation.sourceId));
        for (const name of ["observations", "calls", "results", "resultCoverage", "measurements", "resultReferences", "messages", "taskStates", "sourceFacts"]) require(Array.isArray(conversation[name]));
        const observations = new Set(), calls = new Set(), messages = new Set(), callsByObservation = new Map();
        for (const observation of conversation.observations) {
            shape(observation, ["ref", "sourceRef", "variantRef", "current", "captureCount", "interpretationRef", "completeness"]);
            claim(observation.ref, "native-observation"); observations.add(observation.ref);
            require(reference(observation.sourceRef, "native-source") && reference(observation.variantRef, "native-variant")
                && reference(observation.interpretationRef, "native-interpretation")
                && typeof observation.current === "boolean" && count(observation.captureCount) && observation.captureCount > 0
                && ["response-only", "first-page-only", "drained-exposed-history", "gapped-domain-unqualified", "unknown"].includes(observation.completeness));
            const variant = JSON.stringify([observation.sourceRef, observation.variantRef]);
            require(!variants.has(variant) && (!sourceOwners.has(observation.sourceRef) || sourceOwners.get(observation.sourceRef) === conversation.ref)
                && (!observation.current || !currentSources.has(observation.sourceRef)));
            variants.add(variant);
            sourceOwners.set(observation.sourceRef, conversation.ref);
            if (observation.current) currentSources.add(observation.sourceRef);
            sourceRefs.set(observation.ref, { conversation: conversation.ref, kind: "native-message" });
        }
        require(observations.size > 0);
        for (const call of conversation.calls) {
            shape(call, ["ref", "observationRefs", "names", "outcome", "qualification", "conflicts", "inputAvailability"]);
            claim(call.ref, "native-call"); calls.add(call.ref);
            require(Array.isArray(call.observationRefs) && call.observationRefs.length > 0 && unique(call.observationRefs)
                && call.observationRefs.every(ref => observations.has(ref))
                && Array.isArray(call.names) && unique(call.names) && call.names.every(name => typeof name === "string" && name.length > 0 && name.length <= 256)
                && ["succeeded", "failed", "unknown"].includes(call.outcome)
                && ["recorded-native-outcome", "conflicting-native-outcomes", "unqualified"].includes(call.qualification)
                && (call.qualification === "recorded-native-outcome" ? call.outcome !== "unknown" : call.outcome === "unknown")
                && same(call.conflicts, [...(call.names.length > 1 ? ["native-tool-name-conflict"] : []),
                    ...(call.qualification === "conflicting-native-outcomes" ? ["native-tool-outcome-conflict"] : [])]));
            require(Array.isArray(call.inputAvailability) && call.inputAvailability.length === call.observationRefs.length
                && call.inputAvailability.every(item => availability.includes(item) || item === "not-supplied"));
            for (const ref of call.observationRefs) {
                if (!callsByObservation.has(ref)) callsByObservation.set(ref, []);
                callsByObservation.get(ref).push(call.ref);
            }
        }
        const resultPositions = new Set();
        for (const result of conversation.results) {
            shape(result, ["ref", "observationRef", "callRefs", "index", "statusCode", "errorCode", "paginationPresent", "evidenceLevel"]);
            claim(result.ref, "native-result");
            const position = JSON.stringify([result.observationRef, result.index]);
            require(observations.has(result.observationRef) && Array.isArray(result.callRefs) && unique(result.callRefs)
                && result.callRefs.every(ref => calls.has(ref)) && count(result.index) && !resultPositions.has(position)
                && (result.statusCode === null || Number.isInteger(result.statusCode) && result.statusCode >= 100 && result.statusCode <= 599)
                && (result.errorCode === null || typeof result.errorCode === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(result.errorCode))
                && [null, true].includes(result.paginationPresent) && result.evidenceLevel === "intermediary-reported");
            require(same([...result.callRefs].sort(), [...callsByObservation.get(result.observationRef) ?? []].sort()));
            resultPositions.add(position);
        }
        const resultObservations = new Set();
        for (const item of conversation.resultCoverage) {
            shape(item, ["observationRef", "availability", "declaredRequestCount", "declaredRequestCountIsSuccessDenominator"]);
            require(observations.has(item.observationRef) && !resultObservations.has(item.observationRef)
                && availability.includes(item.availability) && (item.declaredRequestCount === null || count(item.declaredRequestCount))
                && item.declaredRequestCountIsSuccessDenominator === false);
            resultObservations.add(item.observationRef);
        }
        require(conversation.results.every(item => resultObservations.has(item.observationRef)));
        const measurements = new Set(), references = new Set();
        for (const measurement of conversation.measurements) {
            shape(measurement, ["observationRef", "availability", "milliseconds", "unit", "boundaryRef", "basisRef", "comparableToUserResponseLatency"]);
            require(observations.has(measurement.observationRef) && !measurements.has(measurement.observationRef)
                && availability.includes(measurement.availability) && measurement.unit === "ms"
                && measurement.comparableToUserResponseLatency === false
                && (measurement.availability === "recorded" ? Number.isFinite(measurement.milliseconds) && measurement.milliseconds >= 0
                    && reference(measurement.boundaryRef, "native-boundary") && reference(measurement.basisRef, "native-basis")
                    : measurement.milliseconds === null)
                && (measurement.boundaryRef === null || reference(measurement.boundaryRef, "native-boundary"))
                && (measurement.basisRef === null || reference(measurement.basisRef, "native-basis")));
            measurements.add(measurement.observationRef);
        }
        for (const item of conversation.resultReferences) {
            shape(item, ["observationRef", "availability", "unit", "cardinality", "shapeCounts"]);
            require(observations.has(item.observationRef) && !references.has(item.observationRef)
                && availability.includes(item.availability) && item.unit === "source-result-reference-entry");
            if (item.availability === "recorded") {
                require(count(item.cardinality));
                shape(item.shapeCounts, [], ["u", "t", "s", "tp", "d", "ic", "fn", "au", "did", "iid", "sl"]);
                for (const types of Object.values(item.shapeCounts)) {
                    shape(types, [], ["string", "number", "boolean", "object", "array", "null"]);
                    require(Object.values(types).every(count)
                        && Object.values(types).reduce((sum, value) => sum + value, 0) <= item.cardinality);
                }
            } else require(item.cardinality === null && item.shapeCounts === null);
            references.add(item.observationRef);
        }
        const messageUnits = new Map();
        for (const message of conversation.messages) {
            shape(message, ["ref", "observationRef", "unit", "copyKey"]);
            claim(message.ref, "native-message"); messages.add(message.copyKey);
            require(observations.has(message.observationRef) && reference(message.copyKey, "native-copy")
                && ["message-representation-observation", "message-representation-part"].includes(message.unit));
            if (messageUnits.has(message.observationRef)) require(message.unit === "message-representation-part"
                && messageUnits.get(message.observationRef) === "message-representation-part");
            messageUnits.set(message.observationRef, message.unit);
        }
        require(messages.size === conversation.messages.length);
        const taskObservations = new Set();
        for (const task of conversation.taskStates) {
            shape(task, ["ref", "observationRef", "state"]);
            claim(task.ref, "native-task-state");
            require(observations.has(task.observationRef) && !taskObservations.has(task.observationRef)
                && ["running", "needs_user_input", "pending_activity", "completed", "failed", "cancelled", "unknown"].includes(task.state));
            taskObservations.add(task.observationRef);
        }
        for (const fact of conversation.sourceFacts) {
            shape(fact, ["ref", "observationRef", "kind"]);
            claim(fact.ref, "native-fact");
            require(observations.has(fact.observationRef) && factKinds.includes(fact.kind));
            sourceRefs.set(fact.ref, { conversation: conversation.ref, kind: fact.kind });
        }
    }
    const refs = value.conversations.map(conversation => conversation.ref);
    require(same(value.selection.conversationRefs, refs)
        && same(value.selection.observationRefs, value.conversations.flatMap(conversation => conversation.observations.map(observation => observation.ref)))
        && Array.isArray(value.selection.contextOnlyRefs) && unique(value.selection.contextOnlyRefs)
        && value.selection.contextOnlyRefs.every(ref => refs.includes(ref)));
    require(same(value.populations, nativeReportPopulations(value.conversations, value.selection.contextOnlyRefs)) && same(value.coverage, nativeReportCoverage));
    shape(value.disclosure, ["promptMode", "recordedContext", "copies", "unavailableFacts", "coverage"]);
    const { promptMode, recordedContext, ...copies } = value.disclosure;
    validateNativeReportCopies(copies, refs, { promptMode, recordedContext, allowEmpty: value.schemaVersion === 2 });
    const copyMap = new Map(copies.copies.map(copy => [copy.key, copy]));
    for (const copy of copies.copies) require(sourceRefs.get(copy.sourceRef)?.conversation === copy.scenarioRef
        && sourceRefs.get(copy.sourceRef)?.kind === copy.kind);
    for (const conversation of value.conversations) {
        const messageCopies = copies.copies.filter(copy => copy.scenarioRef === conversation.ref && copy.kind === "native-message");
        require(messageCopies.length === conversation.messages.length);
        for (const message of conversation.messages) {
            const copy = copyMap.get(message.copyKey);
            require(copy?.kind === "native-message" && copy.scenarioRef === conversation.ref && copy.sourceRef === message.observationRef);
            if (message.unit === "message-representation-part") require(copy.author === "unknown" && copy.purpose === "context");
        }
    }
    for (const fact of copies.unavailableFacts) require(sourceRefs.get(fact.ref)?.conversation === fact.scenarioRef
        && sourceRefs.get(fact.ref)?.kind === fact.kind);
    const hasFacts = Object.hasOwn(value, "githubEvaluationFacts");
    require(hasFacts === Object.hasOwn(value, "githubEvaluationFactsHash"));
    if (records !== undefined) {
        require(Array.isArray(records));
        const native = records.filter(record => record?.recordKind === "native-conversation");
        for (const record of native) shape(record, ["recordKind", "projectionVersion", "scenarioId", "nativeEvidenceRef"]);
        require(same(native, nativeReportReferences(value)));
        const github = records.filter(record => record?.recordKind !== "native-conversation");
        require(github.every(record => record?.projectionVersion === 3) && hasFacts === (github.length > 0));
    }
    if (hasFacts) {
        const facts = freezeEvaluationFacts(value.githubEvaluationFacts);
        require(facts.metricProjectionVersion === 4 && hash(facts) === value.githubEvaluationFactsHash);
    }
    const generated = new Set([value.githubEvaluationFactsHash, ...(hasFacts ? evaluationGeneratedHashes(value.githubEvaluationFacts) : [])]);
    const metadata = { ...value, disclosure: { ...value.disclosure, copies: copies.copies.map(({ text, ...copy }) => copy) } };
    const findings = scanTree(metadata, generated);
    require(!Object.entries(findings.categories).some(([name, count]) => count && name !== "sensitivity_markings"));
    return value;
}

export function inspectNativeReportNamespace(manifest, snapshot, expectedHash) {
    const present = [manifest, snapshot].some(value => value && (Object.hasOwn(value, "nativeEvidence")
        || Object.hasOwn(value, "nativeEvidenceHash") || value.records?.some(record => record?.recordKind === "native-conversation")));
    if (!present && expectedHash === undefined) return null;
    for (const value of [manifest, snapshot].filter(Boolean)) {
        require(value.schemaVersion === 3 && value.kind === "report"
            && !["evaluationFacts", "evaluationFactsHash"].some(key => Object.hasOwn(value, key))
            && Object.hasOwn(value, "nativeEvidence") && value.nativeEvidence.disclosure.promptMode === value.promptMode);
    }
    if (manifest.periodComparison !== undefined || snapshot?.periodComparison !== undefined || manifest.periodComparisonHash !== undefined) {
        require(manifest.periodComparison?.schemaVersion === 2 && manifest.periodComparison.nativePeriods
            && digest(manifest.periodComparisonHash) && hash(manifest.periodComparison) === manifest.periodComparisonHash
            && (!snapshot || same(snapshot.periodComparison, manifest.periodComparison)));
    }
    const evidence = validateNativeReportEvidence(manifest.nativeEvidence, snapshot?.records);
    require(digest(manifest.snapshotHash) && digest(manifest.nativeEvidenceHash) && hash(evidence) === manifest.nativeEvidenceHash
        && (expectedHash === undefined || digest(expectedHash) && manifest.nativeEvidenceHash === expectedHash));
    if (snapshot) require(same(snapshot.nativeEvidence, evidence));
    return evidence;
}
