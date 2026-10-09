import { hash, TAIL_LIMITS } from "./collector-io.mjs";
import { filterDeletedEvents } from "./deletion-identities.mjs";
import { buildAssessmentModel, assessmentSource, assessmentRef } from "./assessment-read-model.mjs";
import { runMetadataMaintenance, validateMaintenancePlan, maintenanceMetadata } from "./historical-maintenance.mjs";

const { digest, sha, id, instant, requireThat, same, shape } = maintenanceMetadata;
const before = Object.freeze({ version: 1, reason: "error-code-recorded", code: "failure", messageStatus: "text-excluded", messageSignal: null });
const after = Object.freeze({ ...before, messageSignal: "workiq-sign-in-required" });

function validatePlan(plan) {
    validateMaintenancePlan(plan);
    requireThat(Array.isArray(plan.targets) && plan.targets.length === 1, "Failure-signal maintenance requires exactly one unassessed failed call.");
    const target = plan.targets[0];
    shape(target, ["scenarioId", "sourceSessionId", "interactionRef", "recordSha256", "prompt", "call"]);
    requireThat(id(target.scenarioId) && /^[a-f0-9-]{36}$/i.test(target.sourceSessionId)
        && /^interaction-[a-f0-9]{32}$/.test(target.interactionRef) && sha(target.recordSha256), "Invalid exact failure target.");
    shape(target.prompt, ["sourceEventId", "sourceTimestamp", "textSha256"]);
    requireThat(id(target.prompt.sourceEventId) && instant(target.prompt.sourceTimestamp) && sha(target.prompt.textSha256), "Invalid failure prompt identity.");
    shape(target.call, ["toolCallId", "startEventId", "startedAt", "completionEventId", "completedAt"]);
    const call = target.call;
    requireThat([call.toolCallId, call.startEventId, call.completionEventId].every(id)
        && instant(call.startedAt) && instant(call.completedAt)
        && Date.parse(call.startedAt) >= Date.parse(target.prompt.sourceTimestamp)
        && Date.parse(call.completedAt) >= Date.parse(call.startedAt), "Invalid failed-call identity or timing.");
}

function validateState(state, plan, config, records) {
    const target = plan.targets[0], source = assessmentSource(state, config);
    const model = buildAssessmentModel(state, { records, source });
    const mapping = model.catalog.find(item => item.scenarioId === target.scenarioId);
    requireThat(mapping?.status === "retained" && mapping.interactionRef === target.interactionRef
        && model.internals.get(target.interactionRef)?.sourceGroupIds.length === 1, "Failure target canonical interaction is missing or ambiguous.");
    const data = state.personalEvaluation?.modelEvaluation;
    requireThat(!data?.records.some(item => item.interactionRef === target.interactionRef)
        && !data?.runs.some(run => [...run.scope, ...run.results].some(item => item.interactionRef === target.interactionRef))
        && !data?.grants.some(grant => grant.interactionRefs.includes(target.interactionRef)),
    "Failure target is scored, attempted or enrolled; no assessment dependencies may change.");
    const approval = data?.automatic?.approval;
    requireThat(!(approval?.state === "enabled" && approval.sourceConfigRef === source.sourceConfigRef
        && approval.sourceConfigRevision === source.sourceConfigRevision
        && approval.chatRefs.includes(assessmentRef(state, "chat", target.sourceSessionId))
        && (!approval.interactionRefs || approval.interactionRefs.includes(target.interactionRef))),
    "Failure target is inside the automatic-scoring scope.");
}

function projectRecords(records, plan) {
    const target = plan.targets[0];
    requireThat(records.filter(record => record.scenarioId === target.scenarioId).length === 1
        && records.filter(record => record.sourceSessionId === target.sourceSessionId
            && record.userPrompt?.sourceEventId === target.prompt.sourceEventId).length === 1
        && records.flatMap(record => record.sourceSessionId === target.sourceSessionId ? record.toolCalls ?? [] : [])
            .filter(call => call.toolCallId === target.call.toolCallId || call.startEventId === target.call.startEventId
                || call.completionEventId === target.call.completionEventId).length === 1, "Failure target is missing or ambiguous.");
    return records.map(record => {
        if (record.scenarioId !== target.scenarioId) return record;
        requireThat(digest(record) === target.recordSha256 && record.sourceSessionId === target.sourceSessionId, "Exact failure record preimage changed.");
        const prompt = record.userPrompt;
        requireThat(prompt?.status === "full" && prompt.sourceEventId === target.prompt.sourceEventId
            && prompt.sourceTimestamp === target.prompt.sourceTimestamp && typeof prompt.text === "string"
            && hash(prompt.text) === target.prompt.textSha256, "Failure prompt identity, time or retained text changed.");
        requireThat(record.toolCalls.length === 1, "Failure repair requires a single recorded call.");
        const call = record.toolCalls[0];
        for (const key of Object.keys(target.call)) same(call[key], target.call[key], "Failed-call identity or timing changed.");
        requireThat(call.toolSucceeded === false, "Failure target is not a recorded failed call.");
        same(call.failureEvidence, before, "Failure target has missing, newer or conflicting failure metadata.");
        return { ...record, toolCalls: [{ ...call, failureEvidence: { ...after } }] };
    });
}

function projectCheckpoint(checkpoint, source, plan, state, index, { allowPostimage }) {
    requireThat(checkpoint.schemaVersion === 1 && Array.isArray(checkpoint.events), "Invalid retained failure checkpoint.");
    same(checkpoint.cursor, index.sources[source]?.cursor, "Checkpoint cursor and approved index disagree.");
    const call = plan.targets[0].call, next = structuredClone(checkpoint);
    const matches = next.events.filter(event => event.id === call.completionEventId
        || event.type === "tool.execution_complete" && event.data?.toolCallId === call.toolCallId);
    requireThat(matches.length <= 1, "Duplicate retained failure completion.");
    if (matches.length) {
        const event = matches[0];
        requireThat(event.id === call.completionEventId && event.type === "tool.execution_complete"
            && event.timestamp === call.completedAt && event.data?.toolCallId === call.toolCallId
            && event.data.success === false, "Retained failure completion identity changed.");
        // An exact postimage is valid only on same-journal recovery; the transaction seals its bytes.
        if (event.data.wireFailureEvidence?.messageSignal === after.messageSignal) {
            requireThat(allowPostimage, "A failure checkpoint postimage requires its reviewed recovery journal.");
            same(event.data.wireFailureEvidence, after, "Conflicting retained failure postimage.");
        } else {
            same(event.data.wireFailureEvidence, before, "Missing or conflicting retained failure projection.");
            event.data.wireFailureEvidence.messageSignal = after.messageSignal;
        }
    }
    requireThat(next.events.length <= TAIL_LIMITS.maxContextEvents
        && Buffer.byteLength(JSON.stringify(next.events)) <= TAIL_LIMITS.maxContextBytes, "Failure checkpoint exceeds bounds; no context was evicted.");
    same(filterDeletedEvents(next.events, source, state.deletion), next.events, "Deletion filtering would change retained failure checkpoint.");
    return next;
}

export function runFailureSignalMaintenance(options, hooks) {
    return runMetadataMaintenance(options, { validatePlan, validateState, projectRecords, projectCheckpoint }, hooks);
}
