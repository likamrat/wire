import { createHash } from "node:crypto";
import { githubReportCallRows } from "./report-result-projection.mjs";
import { reportContextRef } from "./report-ref.mjs";
import { promptAuthorship } from "./prompt-authorship.mjs";
import { freezeEvaluationFacts } from "./report-facts.mjs";
import { validateReportResultFacts, hasRecordedErrorDetail } from "./report-result-facts.mjs";

const plain = value => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const errorStatus = value => Number.isInteger(value) && value >= 400 && value <= 599;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// These are already qualified by the recorded-result interpreter, not inferred from operation names or durations.
const causeLabels = {
    "sign-in-required": "Sign-in was required at the time",
    "request-timeout": "The request timed out",
    "upstream-connection-timeout": "Connection timed out before response headers",
    "retrieval-stopped": "Retrieval stopped without a detailed cause",
    "tool-unavailable": "The requested tool server was not found",
    "policy-unavailable": "The required policy was unavailable",
    "response-processing": "The response could not be processed",
    "access-denied": "Access was denied",
};
const causeChannels = { call: "Call", result: "Result", "returned-entry": "Returned entry" };

function signalsFor(call, outcome, version) {
    const values = new Map();
    const add = (kind, code = null, status = null) => {
        const signal = { kind, code, status };
        values.set(JSON.stringify(signal), signal);
    };
    if (["failure", "transport"].includes(outcome)) add("call-failure");
    for (const observation of call.observations) {
        if (observation.applicationError === true) add("application-error");
        if (errorStatus(observation.statusCode)) add("result-status", null, observation.statusCode);
        for (const status of Object.values(observation.statusConflict ?? {})) {
            if (errorStatus(status)) add("conflicting-result-status", null, status);
        }
        if (observation.errorCodeStatus === "recorded") add("recorded-error", observation.errorCode,
            errorStatus(observation.errorStatusCode) ? observation.errorStatusCode : null);
        else if (version >= 3 && observation.errorDetailVersion === 1 && hasRecordedErrorDetail(observation))
            add("recorded-error-detail", null, errorStatus(observation.errorStatusCode) ? observation.errorStatusCode : null);
        if (observation.timingFailure?.kind === "request-timeout") add("recorded-request-timeout");
        if (version >= 3) for (const item of observation.interpretation?.items ?? []) {
            if (Object.hasOwn(causeLabels, item.kind) && Object.hasOwn(causeChannels, item.channel)
                && !(item.kind === "request-timeout" && item.channel === "call" && observation.timingFailure))
                add(`cause:${item.channel}:${item.kind}`);
        }
        for (const entry of observation.returnedEntries ?? []) {
            const code = entry.errorCodeStatus === "recorded" ? entry.errorCode : null;
            const conflict = version >= 2 ? entry.statusConflict : null;
            if (conflict && (errorStatus(conflict.reported) || errorStatus(conflict.diagnostic) || code)) {
                add("conflicting-returned-status", code, conflict.reported);
                add("conflicting-diagnostic-status", null, conflict.diagnostic);
            } else if (errorStatus(entry.statusCode) || code) add("returned-api-error", code,
                errorStatus(entry.statusCode) ? entry.statusCode : null);
            else if (version >= 3 && observation.errorDetailVersion === 1 && hasRecordedErrorDetail(entry)) add("returned-error-detail");
        }
    }
    return [...values].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([, value]) => value);
}

function groupsFor(calls, facts, results, version) {
    const outcomes = new Map(facts.recordedOutcomes.filter(row => row.kind === "tool-call").map(row => [row.memberRef, row.outcome]));
    const byRef = new Map(results.calls.map(call => [call.ref, call]));
    const groups = new Map();
    function add(call, kind, signals) {
        if (call.patternKey === null) return;
        const id = "report-pattern-" + hash([call.patternKey, kind, signals]).slice(0, 16);
        if (!groups.has(id)) groups.set(id, { id, patternKey: call.patternKey, kind, signals, callRefs: [],
            interactions: new Map() });
        const group = groups.get(id);
        group.callRefs.push(call.ref);
        if (group.interactions.has(call.scenarioRef) && group.interactions.get(call.scenarioRef) !== call.actor) {
            throw new TypeError("Conflicting prompt authors in a report pattern.");
        }
        group.interactions.set(call.scenarioRef, call.actor);
    }
    for (const call of calls) {
        add(call, "operation", []);
        const signals = signalsFor(byRef.get(call.ref), outcomes.get(call.ref), version);
        if (signals.length) add(call, "errors", signals);
    }
    return [...groups.values()].map(({ interactions, ...group }) => ({
        ...group, callRefs: group.callRefs.sort(), interactionRefs: [...interactions.keys()].sort(),
        authors: Object.fromEntries(["user", "agent", "unknown"].map(actor => [
            actor, [...interactions.values()].filter(value => value === actor).length,
        ])),
    })).sort((a, b) => a.kind.localeCompare(b.kind) || b.interactionRefs.length - a.interactionRefs.length
        || b.callRefs.length - a.callRefs.length || a.id.localeCompare(b.id));
}

export function projectReportPatterns(records, facts, results, key) {
    const patternByMember = new Map();
    for (const entry of facts.patterns.filter(entry => entry.pattern.unitKind === "tool-call")) {
        for (const ref of entry.memberRefs) {
            if (patternByMember.has(ref) && patternByMember.get(ref) !== entry.pattern.key) {
                throw new TypeError("A call has conflicting normalized operation patterns.");
            }
            patternByMember.set(ref, entry.pattern.key);
        }
    }
    const owners = new Map(records.map(record => [record.scenarioId, record]));
    const calls = githubReportCallRows(records, key, facts).map(({ row, ref }) => {
        return {
            ref, scenarioRef: reportContextRef(key, "scenario", row.scenarioId),
            actor: promptAuthorship.read(owners.get(row.scenarioId).userPrompt).actor,
            patternKey: patternByMember.get(ref) ?? null,
        };
    }).sort((a, b) => a.ref.localeCompare(b.ref));
    return validateReportPatterns({
        version: 3, definition: "wire-report-patterns-v3", calls, groups: groupsFor(calls, facts, results, 3),
    }, { facts, results });
}

export function validateReportPatterns(value, { facts, results, records } = {}) {
    const fail = () => { throw new TypeError("Invalid frozen report patterns."); };
    if (!plain(value) || Object.keys(value).length !== 4
        || !["version", "definition", "calls", "groups"].every(key => Object.hasOwn(value, key))
        || ![1, 2, 3].includes(value.version) || value.definition !== `wire-report-patterns-v${value.version}`
        || !Array.isArray(value.calls) || !Array.isArray(value.groups)) fail();
    facts = freezeEvaluationFacts(facts);
    validateReportResultFacts(results);
    const expected = new Set(results.calls.filter(call => call.source === "github-copilot").map(call => call.ref));
    const patterns = new Map(facts.patterns.filter(entry => entry.pattern.unitKind === "tool-call")
        .flatMap(entry => entry.memberRefs.map(ref => [ref, entry.pattern.key])));
    const byRecord = records && new Map(records.map(record => [record.scenarioId, record]));
    const seen = new Set();
    for (const call of value.calls) {
        if (!plain(call) || Object.keys(call).length !== 4
            || !["ref", "scenarioRef", "actor", "patternKey"].every(key => Object.hasOwn(call, key))
            || !expected.has(call.ref) || seen.has(call.ref) || !/^scenario-[a-f0-9]{16}$/.test(call.scenarioRef)
            || !["user", "agent", "unknown"].includes(call.actor)
            || call.patternKey !== (patterns.get(call.ref) ?? null)
            || byRecord && (!byRecord.has(call.scenarioRef)
                || promptAuthorship.read(byRecord.get(call.scenarioRef).prompts.find(prompt => prompt.kind === "origin")).actor !== call.actor)) fail();
        seen.add(call.ref);
    }
    if (seen.size !== expected.size || !same(groupsFor(value.calls, facts, results, value.version), value.groups)) fail();
    return structuredClone(value);
}

export function inspectReportPatterns(manifest, snapshot) {
    if (!Object.hasOwn(manifest, "reportPatterns") && !Object.hasOwn(manifest, "reportPatternsHash")
        && !Object.hasOwn(snapshot ?? {}, "reportPatterns")) return null;
    const value = validateReportPatterns(manifest.reportPatterns, {
        facts: manifest.evaluationFacts, results: manifest.resultFacts, records: snapshot?.records,
    });
    if (manifest.reportPatternsHash !== hash(value)
        || snapshot && !same(snapshot.reportPatterns, value)) throw new TypeError("Report patterns differ from their saved binding.");
    return value;
}

export function reportPatternOperation(group, facts) {
    const pattern = facts.patterns.find(entry => entry.pattern.key === group.patternKey)?.pattern;
    if (!pattern) throw new TypeError("A report pattern's operation is unavailable.");
    const endpoints = pattern.display.endpoints.map(endpoint =>
        endpoint.pathTemplate + (endpoint.queryKeys.length ? ` (${endpoint.queryKeys.join(", ")})` : "")).join("; ");
    return [pattern.display.tool, endpoints].filter(Boolean).join(" / ");
}

export function reportPatternError(group) {
    const timeout = group.signals.some(signal => signal.kind === "recorded-request-timeout");
    const causes = group.signals.flatMap(({ kind }) => {
        const [prefix, channel, name] = kind.split(":");
        return prefix === "cause" && Object.hasOwn(causeChannels, channel) && Object.hasOwn(causeLabels, name)
            ? [`${causeChannels[channel]}: ${causeLabels[name]}`] : [];
    });
    const codes = [...new Set(group.signals.map(signal => signal.code).filter(code => code != null && (!(timeout || causes.length) || code !== "failure")))];
    const conflicts = ["conflicting-returned-status", "conflicting-diagnostic-status"];
    const statuses = [...new Set(group.signals.filter(signal => !conflicts.includes(signal.kind)).map(signal => signal.status).filter(value => value !== null))];
    const conflicting = conflicts.map((kind, index) => {
        const values = [...new Set(group.signals.filter(signal => signal.kind === kind).map(signal => signal.status))];
        return values.length ? `${index ? "diagnostic" : "reported"}: ${values.join(", ")}` : null;
    }).filter(Boolean);
    const detail = [...causes, ...(timeout ? ["Request timed out (MCP -32001)"] : []),
        ...codes, ...statuses.map(status => `Status ${status}`),
        ...(conflicting.length ? [`Conflicting returned-entry statuses (${conflicting.join("; ")})`] : [])].join(", ");
    if (detail) return detail;
    if (group.signals.some(signal => signal.kind === "returned-error-detail")) return "A returned entry reported an error";
    if (group.signals.some(signal => signal.kind === "recorded-error-detail")) return "The tool or its result supplied error details";
    return group.signals.some(signal => signal.kind === "application-error")
        ? "Work IQ reported an error" : "Call failed";
}
