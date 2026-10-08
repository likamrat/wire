// Artificial objects only. Never pass these fixtures to a collector or product store.
import { CAPTURE_LIMITS, DEFINITIONS, CONTRACT_VERSION, defaultConsent } from "../lib/assessment-contract.mjs";
export const at = "2026-10-06T12:00:00.000Z";
export const id = (kind, n = 1) => `${kind}-${n.toString(16).padStart(32, "0")}`;
export const key = n => n.toString(16).padStart(64, "0");
export const basis = () => ({ sourceRevision: 7, membershipRevision: 2, consentRevision: 0, overrideRevision: 0, deletionEpoch: 1 });
export function makeMember(kind = "tool-call", n = 1) {
    const type = { "tool-call": "call", "returned-api-entry": "response", "owned-http": "http", "graph-request-site": "activity", "graph-code-reference": "activity" }[kind];
    return {
        ref: id("record", n), kind, parentRef: kind === "returned-api-entry" ? id("record", 1) : null,
        responseIndex: kind === "returned-api-entry" ? 0 : null,
        identityBasis: { call: "source-and-call", response: "parent-and-response-index", http: "owned-record-id", activity: "source-and-activity" }[type],
        aliases: [{ kind: type, keyHash: key(n) }], deletionKeys: kind === "returned-api-entry" ? [key(1), key(n)] : [key(n)], startedAt: at,
    };
}
export function makeInteraction() {
    return {
        schemaVersion: 1, interactionRef: id("interaction"), sourceRef: id("source"), sourceAdapter: "copilot-local-events-v1",
        sourceGroupRefs: [id("group")], sourceConfigRef: id("config"), sourceConfigRevision: 1, basis: basis(),
        capturedAt: at, retained: true, membershipStatus: "complete-retained", pruned: false,
        excluded: { duplicate: 0, unidentifiable: 0, conflicted: 0, synthetic: 0 },
        message: { eventRef: id("event"), origin: "recorded-unverified", association: "nearest-preceding", completeness: "full", recordedAt: at },
        members: [makeMember(), makeMember("returned-api-entry", 2), makeMember("owned-http", 3), makeMember("graph-request-site", 4), makeMember("graph-code-reference", 5)],
    };
}
export function makeObservation(kind = "tool-outcome") {
    const optional = ["answer", "usage", "explicit-authorization"].includes(kind);
    const payloads = {
        "tool-outcome": { completionRecorded: true, toolSucceeded: true, reportedOutcome: "succeeded" },
        "returned-status": { statusCode: 200, attribution: "response-array-position-not-target", index: 0 },
        "http-status": { statusCode: 200, responseObserved: true, transportError: null },
        "graph-status": { statusCode: 200, evidenceLevel: "output-visible-http", requestCount: null },
        duration: { value: 1000, unit: "ms", boundary: "tool-start-to-completion", clock: "source-timestamps", startedAt: at, endedAt: "2026-10-06T12:00:01.000Z" },
        answer: { textRef: id("text"), utf8Bytes: 24, completeness: "bounded-fragment", finality: "unverified", credentialScreenVersion: 1, credentialScreen: "passed" },
    };
    const supported = Object.hasOwn(payloads, kind);
    return {
        schemaVersion: 1, interactionRef: id("interaction"), basis: { ...basis(), consentRevision: optional ? 1 : 0 },
        createdAt: at, evidenceRefs: supported ? [id("evidence")] : [], observationRef: id("observation"),
        memberRef: optional ? null : id("record", { "tool-outcome": 1, "returned-status": 2, "http-status": 3, "graph-status": 4, duration: 1 }[kind]),
        adapter: kind === "http-status" ? "owned-graph-recorder-v1" : "copilot-local-events-v1",
        kind, origin: optional ? "optional-capture" : "retained-source", availability: supported ? "available" : "unavailable",
        reason: supported ? null : "unsupported-adapter", occurredAt: at, sourceEventRefs: [id("event")],
        deletionKeys: optional ? [1, 2, 3, 4, 5].map(key)
            : kind === "returned-status" ? [1, 2].map(key) : [key({ "http-status": 3, "graph-status": 4 }[kind] ?? 1)],
        payload: payloads[kind] ?? null,
        captureContext: optional ? { consentRevision: 1, sourceConfigRef: id("config"), sourceConfigRevision: 1 } : null,
    };
}
export function enabledConsent() {
    return {
        ...defaultConsent(), revision: 1, state: "enabled", categories: ["answer", "usage", "explicit-authorization"],
        sourceConfigRef: id("config"), sourceConfigRevision: 1, grantedAt: at, grantOrigin: "explicit-in-app-setup", limits: { ...CAPTURE_LIMITS },
    };
}
export function captureRequest() {
    return {
        category: "answer", adapter: "copilot-local-events-v1", expectedConsentRevision: 1,
        sourceConfigRef: id("config"), sourceConfigRevision: 1, sourceApproved: true, alreadyRecorded: true,
        credentialScreen: "passed", utf8Bytes: 24, retainedItemCount: 0, retainedTotalBytes: 0,
    };
}
export function makeAssessment(personal = false) {
    return {
        schemaVersion: 1, interactionRef: id("interaction"), basis: basis(), createdAt: at, evidenceRefs: [],
        assessmentRef: id("assessment", personal ? 2 : 1), checkId: "semantic-answer-correctness", checkVersion: 1,
        dimension: "accuracy", unitRef: id("interaction"), origin: personal ? "user-personal" : "automatic-local", rubricVersion: 1,
        verdict: personal ? "pass" : "unassessed", reason: personal ? "user-verdict" : "unsupported-check",
        revision: 1, supersedes: null, withdrawn: false,
    };
}
export function metricBase(definitionId, eligible = 1, offset = 0) {
    const definition = DEFINITIONS[definitionId];
    return {
        schemaVersion: 1, metricRef: id("metric", offset + 1), definitionId, definitionVersion: 1,
        dimension: definition.form === "cost" ? "cost" : "speed", checkId: null, checkVersion: null,
        unit: definition.unit, boundary: definition.boundary, measurementBasis: definition.basis, basis: basis(),
        origin: "automatic-local", status: "not-measured", value: null, reason: "missing-evidence",
        numerator: null, denominator: null, coverage: { covered: 0, eligible }, counts: null, samples: [], pricing: null,
        eligibleUnitRefs: Array.from({ length: eligible }, (_, i) => id("record", offset + i + 1)), coveredUnitRefs: [], evidenceRefs: [], createdAt: at,
        observedTime: { state: "unavailable", firstAt: null, lastAt: null, datedUnits: 0, undatedUnits: eligible },
    };
}
export function makeRatio(pass = 1, fail = 0, unassessed = 0, evaluatorError = 0, offset = 0) {
    const eligible = pass + fail + unassessed + evaluatorError, covered = pass + fail;
    const base = metricBase("check-pass-share", eligible, offset);
    return {
        ...base, dimension: "execution", checkId: "recorded-tool-success", checkVersion: 1,
        status: covered ? "measured" : evaluatorError ? "evaluator-error" : "unassessed",
        value: covered ? pass / covered : null, reason: covered ? null : evaluatorError ? "evaluator-failure" : "no-assessed-units",
        numerator: pass, denominator: covered, coverage: { covered, eligible }, counts: { pass, fail, unassessed, evaluatorError },
        coveredUnitRefs: base.eligibleUnitRefs.slice(0, covered), evidenceRefs: covered ? [id("evidence", offset + 1)] : [],
    };
}
export function makeDuration(values = [1000], offset = 0) {
    const base = metricBase("tool-duration", values.length, offset);
    const sorted = [...values].sort((a, b) => a - b);
    return {
        ...base, coverage: { covered: values.length, eligible: values.length }, coveredUnitRefs: base.eligibleUnitRefs,
        samples: values.map((value, index) => ({ unitRef: base.eligibleUnitRefs[index], value, evidenceRefs: [id("evidence", offset + index + 1)] })),
        evidenceRefs: values.map((_, index) => id("evidence", offset + index + 1)),
        status: values.length ? "measured" : "not-measured", value: sorted.length ? sorted[Math.ceil(sorted.length / 2) - 1] : null,
        reason: values.length ? null : "missing-evidence",
    };
}
export function makeCost(state = "not-measured") {
    const base = metricBase("attributed-cost");
    const priced = ["measured", "estimated"].includes(state);
    return {
        ...base, status: state, value: priced ? 0.25 : null, reason: priced ? null : state === "unpriced" ? "pricing-unavailable" : "usage-unavailable",
        coverage: { covered: priced ? 1 : 0, eligible: 1 }, coveredUnitRefs: priced ? base.eligibleUnitRefs : [],
        evidenceRefs: priced || state === "unpriced" ? [id("usage")] : [],
        pricing: priced ? { method: state === "measured" ? "recorded-charge" : "versioned-rate-card", reference: id("price"), version: 1, attribution: "explicit-scope", usageRefs: [id("usage")] } : null,
    };
}
export function makeDependencies() {
    return { interactionRefs: [id("interaction")], recordRefs: [id("record")], evidenceRefs: [id("evidence")], deletionKeys: [key(1)], basis: basis() };
}
export function makeCurrent() {
    return { basis: basis(), pendingCleanup: false, retainedRecordRefs: [id("record")], removedIdentityHashes: [] };
}
export function makeSnapshot() {
    return {
        schemaVersion: 1, contractVersion: CONTRACT_VERSION, snapshotRef: id("snapshot"), preparedAt: at,
        namespace: { ref: id("namespace"), version: 1, identityScheme: "keyed-report-pseudonyms-v1" }, basis: basis(),
        scope: { kind: "selected", membership: "exact-retained", from: null, untilExclusive: null, timeZone: "UTC" },
        memberships: [{
            interactionRef: id("interaction"), membershipRevision: 2, status: "complete-retained",
            members: makeInteraction().members.map(({ ref, kind }) => ({ ref, kind })),
        }],
        metrics: [makeRatio(0, 0, 1)], assessments: [makeAssessment()],
        recordedOutcomes: [
            { memberRef: id("record"), kind: "tool-call", definitionVersion: 1, outcome: "partial", outcomeBasis: "recorded-tool-outcome", statusCode: null, evidenceRefs: [id("evidence")] },
            { memberRef: id("record", 2), kind: "returned-api-entry", definitionVersion: 1, outcome: "failure", outcomeBasis: "numeric-returned-status", statusCode: 404, evidenceRefs: [id("evidence", 2)] },
            { memberRef: id("record", 3), kind: "owned-http", definitionVersion: 1, outcome: "transport", outcomeBasis: "owned-transport-error", statusCode: null, evidenceRefs: [id("evidence", 3)] },
            { memberRef: id("record", 4), kind: "graph-request-site", definitionVersion: 1, outcome: "unknown", outcomeBasis: "no-status", statusCode: null, evidenceRefs: [id("evidence", 4)] },
        ],
        patterns: [{
            pattern: {
                version: 1, normalizer: "wire-safe-technical-pattern-v1", key: key(90), unitKind: "tool-call", toolClass: "workiq", method: null, apiVersion: null, targetShape: "unavailable",
                display: { tool: "workiq-fetch", workload: "Mail", attribution: "unavailable", endpoints: [] },
            },
            memberRefs: [id("record")],
        }], privacyProjectionVersion: 1,
    };
}
