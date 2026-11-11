import { buildActivityAnalytics } from "./activity-analytics.mjs";
import { assessmentRef } from "./assessment-read-model.mjs";
import { reportContextRef } from "./report-ref.mjs";
import { freezeReportResultFacts, projectReportResultObservation, validateReportResultFacts } from "./report-result-facts.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";

const resultPresentation = createRecordedResults();

const completion = outcome => ({ success: "succeeded", failure: "failed", partial: "partial", unknown: "unknown" })[outcome] ?? "unknown";
const recorded = field => field?.availability === "recorded" ? field.value : undefined;

// Inputs are the existing selected records and already-qualified native report frame.
// This adapter performs no source reads and grants no report access.
export function projectReportResults(records, key, { githubFacts, nativeFrame, nativeEvidence, nativeSelection, memberRefs } = {}) {
    const state = { pseudonymKey: key }, namespace = assessmentRef(state, "namespace", "report-v1");
    const github = records.filter(record => record.recordKind !== "native-conversation");
    if (github.length !== records.length && !nativeFrame && !nativeSelection) throw new TypeError("Native result facts require qualified native membership.");
    const rows = buildActivityAnalytics(github, { layer: "tool", filters: { scope: "all", includeMetadata: true } }).rows;
    const calls = [], sources = [];
    for (const row of rows) {
        const record = github.find(record => record.scenarioId === row.scenarioId);
        const call = record?.toolCalls?.find(call => row.toolCallId ? call.toolCallId === row.toolCallId
            : row.id === `event:${JSON.stringify([record.sourceSessionId, call.startEventId])}`);
        if (!call) throw new TypeError("Result facts cannot resolve a selected canonical call.");
        const callRef = assessmentRef(state, "record", row.id);
        if (memberRefs && !memberRefs.includes(callRef)) continue;
        const observationRef = reportContextRef(key, "result-observation", JSON.stringify([row.id, call.completionEventId ?? null]));
        const source = { memberRef: callRef, observationRef, source: "github-copilot",
            callCompletion: completion(row.outcome),
            interpretation: resultPresentation.interpretation(call, row.outcome),
            resultEvidence: call.resultEvidence, diagnostic: call.failureEvidence?.diagnostic,
            legacyFailure: call.failureEvidence, retainedResultCount: call.apiResults?.length ?? 0, returnedEntries: call.apiResults ?? null,
            paginationPresent: call.apiResults?.some(result => result.paginationPresent === true) ? true : null };
        calls.push({ ref: callRef, source: source.source, tool: row.tool, completion: completion(row.outcome),
            observations: [projectReportResultObservation(observationRef, source)] });
        sources.push(source);
    }
    const nativeMembers = nativeSelection?.memberRefs
        ?? nativeEvidence?.populations.find(population => population.unit === "native-tool-call")?.refs;
    if (nativeFrame || nativeSelection) {
        if (!Array.isArray(nativeMembers)) throw new TypeError("Native result facts require qualified native membership.");
        const eligible = new Set(nativeMembers);
        for (const record of (nativeFrame ?? nativeSelection).records) for (const call of record.nativeConversation.calls) {
            const callRef = reportContextRef(key, "native-call", call.key);
            if (!eligible.has(callRef) || memberRefs && !memberRefs.includes(callRef)) continue;
            const observations = call.observations.map(observation => {
                const observationRef = reportContextRef(key, "native-observation", observation.observationKey);
                const failure = recorded(observation.fields.failure);
                const returned = observation.outcomes.nestedApi;
                const source = { memberRef: callRef, observationRef, source: record.sourceId,
                    resultEvidence: recorded(observation.fields.resultEvidence), diagnostic: failure?.diagnostic,
                    legacyFailure: failure ? { ...failure, version: 1 } : undefined,
                    retainedResultCount: returned?.availability === "recorded" ? returned.observed.length : null,
                    returnedEntries: returned?.availability === "recorded" ? returned.observed : null,
                    paginationPresent: returned?.observed?.some(result => result.paginationPresent === true) ? true : null };
                sources.push(source);
                return projectReportResultObservation(observationRef, source);
            });
            calls.push({ ref: callRef, source: record.sourceId, tool: null,
                completion: ["succeeded", "failed"].includes(call.outcome.state) ? call.outcome.state : "unknown", observations });
        }
    }
    const expected = memberRefs ?? [
        ...(githubFacts?.memberships.flatMap(group => group.members.filter(member => member.kind === "tool-call").map(member => member.ref))
            ?? calls.filter(call => call.source === "github-copilot").map(call => call.ref)),
        ...(nativeMembers ?? []),
    ];
    const facts = freezeReportResultFacts(calls, namespace);
    validateReportResultFacts(facts, { memberRefs: expected });
    return { facts, sources };
}
