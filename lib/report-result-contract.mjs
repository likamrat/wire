import { WORKIQ_TOOLS } from "./assessment-contract.mjs";

export const REPORT_ERROR_CODES = Object.freeze(["BadRequest", "InvalidRequest", "InvalidAuthenticationToken", "AccessDenied",
    "ErrorAccessDenied", "Authorization_RequestDenied", "Request_ResourceNotFound", "ResourceNotFound", "TooManyRequests",
    "ServiceUnavailable", "InternalServerError", "failure"]);
export const RESULT_FACT_DEFINITION = "wire-recorded-result-facts-v1";
const SOURCES = ["github-copilot", "microsoft-365-chat", "microsoft-365-cowork"];
const COMPLETIONS = ["succeeded", "failed", "partial", "unknown"];
const CONTENT = ["not-supplied", "explicit-null", "recorded-empty", "body-excluded", "unsupported-format", "size-excluded", "partial"];
export const REPORT_RESULT_TEXT_STATUSES = Object.freeze(["recorded", "redacted", "not-supplied", "not-retained", "explicit-null", "recorded-empty",
    "unsupported-format", "size-excluded", "sensitive-excluded"]);
const TEXT_STATUS = REPORT_RESULT_TEXT_STATUSES;
const ref = value => typeof value === "string" && /^(?:record|native-call|result-observation|native-observation)-[a-f0-9]{16}(?:[a-f0-9]{16})?$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const status = value => value === null || Number.isInteger(value) && value >= 100 && value <= 599;
const nullable = (value, predicate) => value === null || predicate(value);
const codeAllowed = value => REPORT_ERROR_CODES.includes(value)
    || Number.isInteger(value) && (value >= -32099 && value <= -32000 || [-32700, -32600, -32601, -32602, -32603].includes(value));
export { codeAllowed as reportErrorCodeAllowed };
function require(condition) { if (!condition) throw new TypeError("Invalid frozen result facts."); }
function shape(value, keys) {
    require(value && Object.getPrototypeOf(value) === Object.prototype && keys.every(key => Object.hasOwn(value, key))
        && Object.keys(value).every(key => keys.includes(key)));
}

export function validateReportResultFacts(value, { memberRefs } = {}) {
    shape(value, ["version", "definition", "namespace", "calls"]);
    require(value.version === 1 && value.definition === RESULT_FACT_DEFINITION
        && typeof value.namespace === "string" && /^namespace-[a-f0-9]{32}$/.test(value.namespace)
        && Array.isArray(value.calls) && value.calls.length <= 100000);
    const ids = new Set(), observations = new Map();
    for (const call of value.calls) {
        shape(call, ["ref", "source", "tool", "completion", "observations"]);
        require(ref(call.ref) && !ids.has(call.ref) && SOURCES.includes(call.source)
            && (call.tool === null || WORKIQ_TOOLS.includes(call.tool)) && COMPLETIONS.includes(call.completion)
            && Array.isArray(call.observations) && call.observations.length > 0 && call.observations.length <= 1000);
        require(call.ref.startsWith(call.source === "github-copilot" ? "record-" : "native-call-"));
        ids.add(call.ref);
        const callObservations = new Set();
        for (const observation of call.observations) {
            shape(observation, ["ref", "resultVersion", "resultSource", "applicationError", "statusCode", "statusConflict", "resultCount",
                "retainedResultCount", "paginationPresent", "returnedEntries", "contentStatus", "diagnosticStatus", "errorCode", "errorCodeStatus",
                "errorCodeBasis", "errorStatusCode", "descriptionStatus", "errorTextAvailable", "descriptionTextAvailable"]);
            require(ref(observation.ref) && !callObservations.has(observation.ref)
                && [null, 1].includes(observation.resultVersion) && nullable(observation.applicationError, value => typeof value === "boolean")
                && status(observation.statusCode) && nullable(observation.resultCount, integer) && nullable(observation.retainedResultCount, integer)
                && [null, true].includes(observation.paginationPresent)
                && nullable(observation.contentStatus, value => CONTENT.includes(value))
                && nullable(observation.diagnosticStatus, value => TEXT_STATUS.includes(value))
                && nullable(observation.descriptionStatus, value => TEXT_STATUS.includes(value))
                && nullable(observation.errorTextAvailable, value => typeof value === "boolean")
                && nullable(observation.descriptionTextAvailable, value => typeof value === "boolean")
                && nullable(observation.errorCode, codeAllowed) && status(observation.errorStatusCode)
                && [null, "diagnostic-field", "retained-failure-projection"].includes(observation.errorCodeBasis)
                && ["not-supplied", "recorded", "withheld"].includes(observation.errorCodeStatus));
            require(observation.ref.startsWith(call.source === "github-copilot" ? "result-observation-" : "native-observation-"));
            require(observation.resultSource === (observation.resultVersion === null ? null
                : call.source === "github-copilot" ? "sdk-result" : "native-tool-result"));
            if (call.source !== "github-copilot") require(observation.applicationError === null
                && observation.statusCode === null && observation.statusConflict === null && observation.resultCount === null);
            require((observation.errorCodeStatus === "recorded") === (observation.errorCode !== null));
            require((observation.errorCodeStatus === "not-supplied") === (observation.errorCodeBasis === null));
            require(observation.resultCount === null || observation.retainedResultCount === null || observation.resultCount >= observation.retainedResultCount);
            if (observation.contentStatus === "partial") require(call.source === "github-copilot" && observation.resultCount === null);
            if (observation.returnedEntries !== null) {
                require(Array.isArray(observation.returnedEntries) && observation.returnedEntries.length <= 100
                    && observation.returnedEntries.length === observation.retainedResultCount);
                const indexes = new Set();
                for (const entry of observation.returnedEntries) {
                    shape(entry, ["index", "statusCode", "errorCode", "errorCodeStatus", "diagnosticStatus", "errorTextAvailable", "paginationPresent"]);
                    require(integer(entry.index) && !indexes.has(entry.index) && status(entry.statusCode)
                        && nullable(entry.errorCode, codeAllowed) && ["not-supplied", "recorded", "withheld"].includes(entry.errorCodeStatus)
                        && (entry.errorCodeStatus === "recorded") === (entry.errorCode !== null)
                        && nullable(entry.diagnosticStatus, value => TEXT_STATUS.includes(value))
                        && nullable(entry.errorTextAvailable, value => typeof value === "boolean") && [null, true].includes(entry.paginationPresent));
                    indexes.add(entry.index);
                }
            }
            if (observation.statusConflict !== null) {
                shape(observation.statusConflict, ["structured", "text"]);
                require(call.source === "github-copilot" && observation.statusCode === null
                    && observation.statusConflict.structured !== null && observation.statusConflict.text !== null
                    && status(observation.statusConflict.structured) && status(observation.statusConflict.text)
                    && observation.statusConflict.structured !== observation.statusConflict.text);
            }
            if (observation.resultVersion === null) require(observation.applicationError === null && observation.statusCode === null
                && observation.statusConflict === null && observation.resultCount === null && observation.contentStatus === null
                && observation.descriptionStatus === null && observation.descriptionTextAvailable === null);
            const serialized = JSON.stringify(observation);
            require(!observations.has(observation.ref) || observations.get(observation.ref) === serialized);
            observations.set(observation.ref, serialized);
            callObservations.add(observation.ref);
        }
    }
    if (memberRefs !== undefined) require(Array.isArray(memberRefs) && new Set(memberRefs).size === memberRefs.length
        && memberRefs.length === ids.size && memberRefs.every(id => ids.has(id)));
    require(new TextEncoder().encode(JSON.stringify(value)).length <= 16 * 1024 * 1024);
    return value;
}

export function freezeReportResultFacts(calls, namespace) {
    return structuredClone(validateReportResultFacts({ version: 1, definition: RESULT_FACT_DEFINITION, namespace, calls }));
}

export function reportResultMemberRefs(container) {
    const github = container.evaluationFacts ?? container.nativeEvidence?.githubEvaluationFacts;
    return [...(github?.memberships.flatMap(group => group.members.filter(member => member.kind === "tool-call").map(member => member.ref)) ?? []),
        ...(container.nativeEvidence?.populations.find(population => population.unit === "native-tool-call")?.refs ?? [])];
}

// A period report has two measured cohorts. This union is only a text-copy binding,
// never a third measured population or a substitute for either side's facts.
export function periodResultTextFacts(period) {
    const calls = new Map();
    const sides = Object.values(period.periods);
    for (const side of sides) {
        if (!side.resultFacts) continue;
        validateReportResultFacts(side.resultFacts);
        for (const call of side.resultFacts.calls) {
            const previous = calls.get(call.ref);
            require(!previous || JSON.stringify(previous) === JSON.stringify(call));
            calls.set(call.ref, call);
        }
    }
    return freezeReportResultFacts([...calls.values()], sides[0].resultFacts?.namespace ?? sides[0].facts.namespace.ref);
}

function oneFact(call, field) {
    const values = [...new Set(call.observations.map(value => value[field]).filter(value => value !== null))];
    return { value: values.length === 1 ? values[0] : null, conflict: values.length > 1 };
}
export function summarizeReportResultFacts(facts) {
    validateReportResultFacts(facts);
    return SOURCES.map(source => {
        const calls = facts.calls.filter(call => call.source === source);
        const flags = calls.map(call => oneFact(call, "applicationError"));
        const known = flags.filter(flag => flag.value !== null), errors = known.filter(flag => flag.value === true).length;
        const statuses = calls.map(call => ({ ...oneFact(call, "statusCode"),
            explicitConflict: call.observations.some(observation => observation.statusConflict !== null) }));
        return {
            source, calls: calls.length, completions: calls.filter(call => call.completion === "succeeded").length,
            application: { known: known.length, errors: known.length ? errors : null, unknown: calls.length - known.length,
                conflicting: flags.filter(flag => flag.conflict).length, complete: calls.length > 0 && known.length === calls.length },
            status: { known: statuses.filter(value => value.value !== null && !value.explicitConflict).length,
                conflicting: statuses.filter(value => value.conflict || value.explicitConflict).length },
            cappedCalls: calls.filter(call => call.observations.some(value => value.resultCount !== null
                && value.retainedResultCount !== null && value.resultCount > value.retainedResultCount)).length,
            paginationObservedCalls: calls.filter(call => call.observations.some(value => value.paginationPresent === true)).length,
            resultUnavailable: calls.filter(call => call.observations.every(value => value.resultVersion === null)).length,
        };
    }).filter(row => row.calls > 0);
}

export function compareReportResultFacts(baseline, later, { cohort = "snapshots", comparison } = {}) {
    if (!["snapshots", "non-overlapping", "later-additions"].includes(cohort)) throw new TypeError("Unsupported result-comparison cohort.");
    if (!baseline || !later) return { version: 1, status: "unavailable", cohort,
        reason: !baseline && !later ? "result-facts-not-saved" : !baseline ? "baseline-result-facts-not-saved" : "later-result-facts-not-saved", groups: [] };
    validateReportResultFacts(baseline); validateReportResultFacts(later);
    const sameNamespace = baseline.namespace === later.namespace;
    if (!sameNamespace && cohort !== "snapshots") return { version: 1, status: "unavailable", cohort, reason: "overlap-unverified", groups: [] };
    const beforeCalls = new Map(baseline.calls.map(call => [call.ref, call])), afterCalls = new Map(later.calls.map(call => [call.ref, call]));
    const selected = resultCohortFacts(baseline, later, cohort, comparison);
    const shared = new Set(baseline.calls.filter(call => selected.sourceStates[call.source].identityVerified && afterCalls.has(call.ref)).map(call => call.ref));
    const activeSources = new Set(SOURCES.filter(source => {
        const presence = selected.sourceStates[source].present;
        return presence.baseline || presence.later;
    }));
    const overlapVerified = sameNamespace && [...activeSources].every(source => selected.sourceStates[source].identityVerified);
    const a = summarizeReportResultFacts(selected.baseline), b = summarizeReportResultFacts(selected.later);
    const signature = call => JSON.stringify(call.observations.map(({ ref, ...facts }) => JSON.stringify(facts)).sort());
    const changed = [...shared].filter(ref => signature(beforeCalls.get(ref)) !== signature(afterCalls.get(ref)));
    const changes = changed.slice(0, 12).map(ref => ({ ref, source: afterCalls.get(ref).source, tool: afterCalls.get(ref).tool,
        baseline: structuredClone(beforeCalls.get(ref).observations), later: structuredClone(afterCalls.get(ref).observations) }));
    const groups = SOURCES.flatMap(source => {
        const before = a.find(row => row.source === source), after = b.find(row => row.source === source);
        const qualification = selected.sourceStates[source];
        const unavailable = [qualification.baseline, qualification.later].includes("cohort-unavailable");
        if (!before && !after && (!activeSources.has(source) || !unavailable)) return [];
        const comparable = qualification.identityVerified && before?.application.complete && after?.application.complete;
        return [{ source, baseline: before ?? null, later: after ?? null,
            baselineState: qualification.baseline, laterState: qualification.later,
            overlappingReferences: qualification.identityVerified ? [...shared].filter(ref => beforeCalls.get(ref).source === source).length : null,
            applicationErrorDelta: comparable ? after.application.errors / after.calls * 100 - before.application.errors / before.calls * 100 : null,
            reason: unavailable ? "source-cohort-unavailable" : !before || !after ? "source-population-missing" : !sameNamespace ? "source-namespace-differs"
                : !qualification.identityVerified ? "source-interpretation-unverified"
                : !comparable ? "application-result-coverage-incomplete" : null }];
    });
    const available = groups.some(group => group.baseline || group.later);
    return { version: 1, status: available ? "available" : "unavailable", reason: available ? null : groups.length ? "source-cohort-unavailable" : "empty-population",
        identityRelation: !sameNamespace ? "different-namespace" : overlapVerified ? "same-namespace" : "unverified", cohort,
        shared: { count: overlapVerified ? shared.size : null, changedTypedFacts: overlapVerified ? changed.length : null },
        changes, additionalChangedCalls: changed.length - changes.length, groups };
}

export function resultCohortFacts(baseline, later, cohort = "snapshots", comparison) {
    if (!["snapshots", "non-overlapping", "later-additions"].includes(cohort)) throw new TypeError("Unsupported result-comparison cohort.");
    if (baseline) validateReportResultFacts(baseline);
    if (later) validateReportResultFacts(later);
    const sameNamespace = Boolean(baseline && later && baseline.namespace === later.namespace);
    if (cohort !== "snapshots" && !sameNamespace) return null;
    const observedSources = { baseline: new Set(baseline?.calls.map(call => call.source) ?? []),
        later: new Set(later?.calls.map(call => call.source) ?? []) };
    // Saved reports supply the core source qualifications; live periods share one accepted source frame.
    const sourceStates = Object.fromEntries(SOURCES.map(source => {
        let state = { baseline: "available", later: "available", identityVerified: sameNamespace,
            present: { baseline: observedSources.baseline.has(source), later: observedSources.later.has(source) } };
        if (comparison !== undefined) {
            if (source === "github-copilot") {
                const tool = comparison.toolComparison;
                if (tool) require(tool.cohort === cohort);
                const availability = cohort === "snapshots" || tool?.selected ? "available" : "cohort-unavailable";
                state = { ...state, baseline: availability, later: availability, identityVerified: sameNamespace && tool?.overlap?.verified === true,
                    present: tool ? { baseline: true, later: true } : state.present };
            } else {
                const native = comparison.nativeComparison;
                if (native) require(native.cohort === cohort && Array.isArray(native.units));
                const unit = native?.units.find(row => row.sourceId === source && row.unit === "native-tool-call");
                if (unit) {
                    require(["available", "source-not-present", "cohort-unavailable"].includes(unit.baselineState)
                        && ["available", "source-not-present", "cohort-unavailable"].includes(unit.laterState));
                    state = { baseline: unit.baselineState, later: unit.laterState,
                        present: { baseline: unit.baselineState !== "source-not-present", later: unit.laterState !== "source-not-present" },
                        identityVerified: sameNamespace && integer(unit.overlappingReferences) };
                } else state = { ...state, baseline: "cohort-unavailable", later: "cohort-unavailable", identityVerified: false };
            }
        }
        return [source, state];
    }));
    const ids = new Set(baseline?.calls.map(call => call.ref) ?? []);
    const shared = new Set((later?.calls ?? []).filter(call => sourceStates[call.source].identityVerified && ids.has(call.ref)).map(call => call.ref));
    const select = (facts, side) => !facts ? facts : { ...facts, calls: facts.calls.filter(call =>
        sourceStates[call.source][side] === "available"
        && !(cohort === "non-overlapping" || cohort === "later-additions" && side === "later" ? shared.has(call.ref) : false)) };
    const unavailableSources = Object.fromEntries(["baseline", "later"].map(side => [side,
        SOURCES.filter(source => sourceStates[source].present[side] && sourceStates[source][side] === "cohort-unavailable").sort()]));
    return {
        baseline: select(baseline, "baseline"), later: select(later, "later"), sourceStates, unavailableSources,
    };
}
