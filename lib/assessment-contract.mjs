// Shared executable contract. No product imports, I/O, discovery, or consent changes.
export const CONTRACT_VERSION = "WIRE-PERSONAL-EVAL-v1";
export const SCHEMA_VERSION = 1;
export const KINDS = Object.freeze(["tool-call", "returned-api-entry", "owned-http", "graph-request-site", "graph-code-reference"]);
export const DIMENSIONS = Object.freeze(["accuracy", "speed", "cost", "answer-trust", "action-trust"]);
export const CURRENT_DIMENSIONS = Object.freeze(["accuracy", "speed", "answer-trust", "action-trust"]);
export const METRIC_PROJECTION_VERSION = 2;
export const BASIS_KEYS = Object.freeze(["sourceRevision", "membershipRevision", "consentRevision", "overrideRevision", "deletionEpoch"]);
export const CAPTURE_CATEGORIES = Object.freeze(["answer", "usage", "explicit-authorization"]);
export const CAPTURE_LIMITS = Object.freeze({ bytesPerItem: 65536, itemsPerInteraction: 20, bytesPerInteraction: 262144 });
export const ADAPTER_CAPABILITIES = Object.freeze({
    "copilot-local-events-v1": Object.freeze(["tool-outcome", "returned-status", "graph-status", "duration", "answer"]),
    "owned-graph-recorder-v1": Object.freeze(["http-status", "duration"]),
});
export const RULES = Object.freeze({
    "recorded-tool-success": Object.freeze({
        version: 1, dimension: "execution", observation: "tool-outcome", eligibleKind: "tool-call",
        preconditions: "Matching retained completion and explicit boolean success; partial is not binary.",
        pass: "toolSucceeded === true", fail: "toolSucceeded === false",
        claim: "Recorded tool completion only; not task correctness.",
    }),
    "returned-status-2xx": Object.freeze({
        version: 1, dimension: "execution", observation: "returned-status", eligibleKind: "returned-api-entry",
        preconditions: "Numeric 100..599 status on this returned entry, never inferred target attribution.",
        pass: "200 <= statusCode < 300", fail: "400 <= statusCode <= 599",
        claim: "Intermediary-reported status only; 1xx/3xx remain nonbinary.",
    }),
    "graph-output-status-2xx": Object.freeze({
        version: 1, dimension: "execution", observation: "graph-status", eligibleKind: "graph-request-site",
        preconditions: "Output-visible HTTP evidence and explicit numeric status on this recorded site.",
        pass: "200 <= statusCode < 300", fail: "400 <= statusCode <= 599",
        claim: "Output-visible status, not an independently measured HTTP attempt.",
    }),
    "owned-http-status-2xx": Object.freeze({
        version: 1, dimension: "execution", observation: "http-status", eligibleKind: "owned-http",
        preconditions: "Real owned recorder, observed response, numeric status; no synthetic transport.",
        pass: "200 <= statusCode < 300", fail: "400 <= statusCode <= 599",
        claim: "Observed response status only; no authorization or correctness inference.",
    }),
    "answer-evidence-present": Object.freeze({
        version: 1, dimension: "evidence", observation: "answer", eligibleKind: "interaction",
        preconditions: "Consented, screened, retained answer fragment from the same approved source.",
        pass: "retained bytes > 0", fail: "No negative quality verdict from missing text.",
        claim: "Evidence availability only; excluded from all accuracy/trust pass shares.",
    }),
    "semantic-answer-correctness": Object.freeze({
        version: 1, dimension: "accuracy", observation: null, eligibleKind: "interaction",
        preconditions: "No supported semantic evaluator in local-rules v1.",
        pass: null, fail: null, claim: "Automatic result always unassessed; optional personal verdict is separate.",
    }),
    "answer-support-validity": Object.freeze({
        version: 1, dimension: "answer-trust", observation: null, eligibleKind: "interaction",
        preconditions: "No supported claim-to-grounding validator in local-rules v1.",
        pass: null, fail: null, claim: "Citations, count, presence, or HTTP acceptance do not establish support.",
    }),
    "action-authorization-compliance": Object.freeze({
        version: 1, dimension: "action-trust", observation: null, eligibleKind: "interaction",
        preconditions: "No supported retained explicit-decision/action matching schema in maintained adapters.",
        pass: null, fail: null, claim: "Authorization header, tool success, or HTTP status is not human permission.",
    }),
    "request-requirements-corroborated": Object.freeze({
        version: 1, dimension: "accuracy", observation: null, eligibleKind: "interaction", evaluator: "model",
        preconditions: "Explicit scoped evaluator approval and validated request/answer/reference anchors.",
        pass: "Every applicable evidence-grounded requirement is met.", fail: "At least one anchored requirement is not met.",
        claim: "Model assessment of recorded evidence, not independent ground truth.",
    }),
    "recorded-answer-support": Object.freeze({
        version: 1, dimension: "answer-trust", observation: null, eligibleKind: "interaction", evaluator: "model",
        preconditions: "Complete answer segmentation and validated recorded-reference anchors.",
        pass: "Every factual segment is supported.", fail: "At least one factual segment is contradicted.",
        claim: "Model-assessed support from recorded references, not citation count.",
    }),
    "action-intent-alignment": Object.freeze({
        version: 1, dimension: "action-trust", observation: null, eligibleKind: "interaction", evaluator: "model",
        preconditions: "Every selected action is assessed against anchored explicit recorded intent.",
        pass: "All selected actions align with the request.", fail: "At least one selected action is outside the request.",
        claim: "Model-assessed intent alignment, not proof of authorization.",
    }),
});
export const DEFINITIONS = Object.freeze({
    "check-pass-share": Object.freeze({ version: 1, unit: "ratio", boundary: "one-rule-per-eligible-unit", basis: "assessed-pass-over-pass-plus-fail", form: "counts" }),
    "tool-duration": Object.freeze({ version: 1, unit: "ms", boundary: "tool-start-to-completion", basis: "retained-event-timestamps", form: "samples" }),
    "http-response-duration": Object.freeze({ version: 1, unit: "ms", boundary: "http-dispatch-to-response-headers", basis: "owned-monotonic-clock", form: "samples" }),
    "http-error-duration": Object.freeze({ version: 1, unit: "ms", boundary: "http-dispatch-to-transport-error", basis: "owned-monotonic-clock", form: "samples" }),
    "interaction-latency": Object.freeze({ version: 1, unit: "ms", boundary: "verified-request-to-final-answer", basis: "verified-turn-start-and-final-answer", form: "unsupported" }),
    "recorded-response-duration": Object.freeze({ version: 1, unit: "ms", boundary: "recorded-request-to-final-answer", basis: "recorded-final-phase-and-completed-turn", form: "samples" }),
    "attributed-cost": Object.freeze({ version: 1, unit: "USD", boundary: "explicit-attributed-usage-scope", basis: "recorded-charge-or-versioned-pricing", form: "cost" }),
});
const REASONS = Object.freeze([
    "missing-evidence", "missing-completion", "nonbinary-outcome", "unsupported-check", "unsupported-adapter",
    "capture-disabled", "category-not-consented", "stale-consent", "stale-source", "stale-membership",
    "stale-override", "deletion-pending", "deleted-dependency", "credential-excluded", "capture-limit",
    "partial-evidence", "unverified-association", "invalid-timing", "usage-unavailable", "pricing-unavailable",
    "no-eligible-units", "no-assessed-units", "evaluator-failure", "user-withdrawn", "user-verdict", "not-applicable",
]);
export class ContractError extends Error {
    constructor(code) { super(code); this.name = "ContractError"; this.code = code; }
}
const requireThat = (condition, code) => { if (!condition) throw new ContractError(code); };
const oneOf = values => value => requireThat(values.includes(value), "invalid-enum");
const integer = value => requireThat(Number.isSafeInteger(value) && value >= 0, "invalid-count");
const positive = value => { integer(value); requireThat(value > 0, "invalid-positive-count"); };
const number = value => requireThat(Number.isFinite(value) && value >= 0, "invalid-nonnegative-number");
const boolean = value => requireThat(typeof value === "boolean", "invalid-boolean");
const ref = value => requireThat(typeof value === "string" && /^[a-z]+-[a-f0-9]{32}$/.test(value), "invalid-opaque-reference");
const hash = value => requireThat(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "invalid-identity-hash");
const nil = value => requireThat(value === null, "expected-null");
const nullable = validator => value => { if (value !== null) validator(value); };
const literal = expected => value => requireThat(value === expected, "invalid-literal");
const list = (validator, max = 100000) => value => {
    requireThat(Array.isArray(value) && value.length <= max, "invalid-list");
    value.forEach(validator);
};
const unique = values => requireThat(new Set(values).size === values.length, "duplicate-identity");
function shape(value, fields) {
    requireThat(value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype, "expected-plain-object");
    requireThat(Object.keys(value).length === Object.keys(fields).length && Object.keys(value).every(key => Object.hasOwn(fields, key)), "unexpected-or-missing-field");
    for (const [key, validator] of Object.entries(fields)) validator(value[key]);
    return value;
}
function instant(value) {
    requireThat(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value), "invalid-instant");
    const date = new Date(value);
    requireThat(Number.isFinite(date.getTime()) && date.toISOString() === value, "invalid-instant");
}
const refs = value => { list(ref)(value); unique(value); };
const hashes = value => { list(hash)(value); unique(value); };
const reason = nullable(oneOf(REASONS));
const version = literal(SCHEMA_VERSION);
export const validateBasis = value => shape(value, Object.fromEntries(BASIS_KEYS.map(key => [key, integer])));
const coverage = value => {
    shape(value, { covered: integer, eligible: integer });
    requireThat(value.covered <= value.eligible, "impossible-coverage");
};
const nullableInstant = nullable(instant);
const evaluator = value => shape(value, {
    provider: literal("github-copilot"),
    model: value => requireThat(typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value), "invalid-evaluator-model"),
    rubricId: literal("wire-recorded-interaction-review"), rubricVersion: positive,
});
const metadata = {
    schemaVersion: version, interactionRef: ref, basis: validateBasis,
    createdAt: instant, evidenceRefs: refs,
};
const kindCheck = oneOf(KINDS);
function member(value) {
    shape(value, {
        ref, kind: kindCheck, parentRef: nullable(ref), responseIndex: nullable(integer),
        identityBasis: oneOf(["source-and-call", "source-and-start", "source-and-activity", "owned-record-id", "parent-and-response-index"]),
        aliases: list(alias => shape(alias, { kind: oneOf(["call", "start", "activity", "http", "response"]), keyHash: hash })),
        deletionKeys: hashes, startedAt: nullableInstant,
    });
    requireThat(value.aliases.length > 0 && value.deletionKeys.length > 0, "missing-identity");
    unique(value.aliases.map(alias => `${alias.kind}:${alias.keyHash}`));
    const allowed = {
        "tool-call": ["source-and-call", "source-and-start"], "returned-api-entry": ["parent-and-response-index"],
        "owned-http": ["owned-record-id"], "graph-request-site": ["source-and-activity"], "graph-code-reference": ["source-and-activity"],
    };
    requireThat(allowed[value.kind].includes(value.identityBasis), "identity-kind-mismatch");
    requireThat(value.kind === "returned-api-entry" ? value.parentRef !== null && value.responseIndex !== null : value.parentRef === null && value.responseIndex === null, "invalid-parent-membership");
}
export function validateInteraction(value) {
    shape(value, {
        schemaVersion: version, interactionRef: ref, sourceRef: ref,
        sourceAdapter: oneOf(Object.keys(ADAPTER_CAPABILITIES)), sourceGroupRefs: refs,
        sourceConfigRef: nullable(ref), sourceConfigRevision: integer,
        basis: validateBasis, capturedAt: nullableInstant, retained: literal(true),
        membershipStatus: oneOf(["complete-retained", "partial", "unverified"]), pruned: boolean,
        excluded: item => shape(item, { duplicate: integer, unidentifiable: integer, conflicted: integer, synthetic: integer }),
        message: item => shape(item, {
            eventRef: nullable(ref), origin: oneOf(["user", "agent", "recorded-unverified", "coordinator", "unavailable"]),
            association: oneOf(["nearest-preceding", "explicit-source-link", "unverified", "unavailable"]),
            completeness: oneOf(["full", "partial", "unavailable"]), recordedAt: nullableInstant,
        }),
        members: list(member),
    });
    requireThat(value.members.length > 0 && value.sourceGroupRefs.length > 0, "empty-retained-interaction");
    const byRef = new Map(value.members.map(item => [item.ref, item]));
    unique(value.members.map(item => item.ref));
    unique(value.members.flatMap(item => item.aliases.map(alias => `${alias.kind}:${alias.keyHash}`)));
    unique(value.members.filter(item => item.kind === "returned-api-entry").map(item => `${item.parentRef}:${item.responseIndex}`));
    for (const item of value.members) if (item.parentRef) {
        requireThat(byRef.get(item.parentRef)?.kind === "tool-call", "orphan-returned-entry");
        requireThat(byRef.get(item.parentRef).deletionKeys.every(key => item.deletionKeys.includes(key)), "missing-parent-deletion-alias");
    }
    if (value.excluded.conflicted || value.excluded.unidentifiable || value.pruned) {
        requireThat(value.membershipStatus !== "complete-retained", "overstated-membership");
    }
    return value;
}
const OBSERVATIONS = ["tool-outcome", "returned-status", "http-status", "graph-status", "duration", ...CAPTURE_CATEGORIES];
const statusCode = nullable(value => requireThat(Number.isInteger(value) && value >= 100 && value <= 599, "invalid-status"));
function payload(kind, value) {
    if (kind === "tool-outcome") {
        shape(value, { completionRecorded: boolean, toolSucceeded: nullable(boolean), reportedOutcome: oneOf(["succeeded", "failed", "partial", "unknown"]) });
        requireThat(value.completionRecorded || value.toolSucceeded === null && value.reportedOutcome === "unknown", "outcome-without-completion");
        requireThat(value.toolSucceeded !== false || value.reportedOutcome !== "succeeded", "contradictory-outcome");
        requireThat(value.toolSucceeded !== true || value.reportedOutcome !== "failed", "contradictory-outcome");
    } else if (kind === "returned-status") {
        shape(value, { statusCode, attribution: literal("response-array-position-not-target"), index: integer });
    } else if (kind === "http-status") {
        shape(value, { statusCode, responseObserved: boolean, transportError: nullable(oneOf(["network-error", "AbortError", "TimeoutError"])) });
        requireThat(value.responseObserved ? value.statusCode !== null && value.transportError === null : value.statusCode === null, "unobserved-http-status");
    } else if (kind === "graph-status") {
        shape(value, { statusCode, evidenceLevel: oneOf(["requested-direct-graph", "output-visible-http", "code-reference"]), requestCount: nil });
        requireThat(value.evidenceLevel === "output-visible-http" ? value.statusCode !== null : value.statusCode === null, "unobserved-graph-status");
    } else if (kind === "duration") {
        shape(value, {
            value: number, unit: literal("ms"),
            boundary: oneOf(["tool-start-to-completion", "http-dispatch-to-response-headers", "http-dispatch-to-transport-error"]),
            clock: oneOf(["source-timestamps", "monotonic"]), startedAt: instant, endedAt: nullableInstant,
        });
        if (value.boundary === "tool-start-to-completion") {
            requireThat(value.clock === "source-timestamps" && value.endedAt !== null && Date.parse(value.endedAt) - Date.parse(value.startedAt) === value.value, "inconsistent-duration");
        } else requireThat(value.clock === "monotonic", "inconsistent-duration");
    } else if (kind === "answer") {
        shape(value, {
            textRef: ref, utf8Bytes: positive, completeness: oneOf(["full-record", "bounded-fragment"]),
            finality: literal("unverified"), credentialScreenVersion: literal(1), credentialScreen: literal("passed"),
        });
        requireThat(value.utf8Bytes <= CAPTURE_LIMITS.bytesPerItem, "capture-limit");
    } else throw new ContractError("unsupported-adapter");
}
export function validateObservation(value) {
    shape(value, {
        ...metadata, observationRef: ref, memberRef: nullable(ref), adapter: oneOf(Object.keys(ADAPTER_CAPABILITIES)),
        kind: oneOf(OBSERVATIONS), origin: oneOf(["retained-source", "optional-capture"]),
        availability: oneOf(["available", "unavailable"]), reason, occurredAt: nullableInstant,
        sourceEventRefs: refs, deletionKeys: hashes, payload: () => {},
        captureContext: nullable(item => shape(item, { consentRevision: integer, sourceConfigRef: ref, sourceConfigRevision: integer })),
    });
    requireThat(value.sourceEventRefs.length > 0 && value.deletionKeys.length > 0, "missing-dependency");
    requireThat(value.origin === (CAPTURE_CATEGORIES.includes(value.kind) ? "optional-capture" : "retained-source"), "invalid-evidence-origin");
    requireThat(value.origin === "optional-capture" || value.captureContext === null, "unexpected-capture-context");
    requireThat(CAPTURE_CATEGORIES.includes(value.kind) || value.memberRef !== null, "missing-member");
    if (value.availability === "unavailable") {
        nil(value.payload); requireThat(value.reason !== null, "missing-unavailable-reason");
    } else {
        nil(value.reason);
        requireThat(ADAPTER_CAPABILITIES[value.adapter].includes(value.kind), "unsupported-adapter");
        requireThat(value.evidenceRefs.length > 0, "missing-evidence-reference");
        if (value.origin === "optional-capture") requireThat(value.captureContext !== null && value.captureContext.consentRevision === value.basis.consentRevision, "missing-capture-context");
        payload(value.kind, value.payload);
    }
    return value;
}
export function validateObservationForInteraction(observation, interaction, consent) {
    validateObservation(observation); validateInteraction(interaction); validateConsent(consent);
    requireThat(observation.interactionRef === interaction.interactionRef, "observation-outside-interaction");
    for (const key of BASIS_KEYS) requireThat(observation.basis[key] === interaction.basis[key], `stale-${key}`);
    const item = interaction.members.find(item => item.ref === observation.memberRef);
    const allowed = {
        "tool-outcome": ["tool-call"], "returned-status": ["returned-api-entry"], "http-status": ["owned-http"],
        "graph-status": ["graph-request-site", "graph-code-reference"], duration: ["tool-call", "owned-http"],
    };
    if (allowed[observation.kind]) requireThat(item && allowed[observation.kind].includes(item.kind), "evidence-unit-mismatch");
    const requiredDeletionKeys = item ? item.deletionKeys : interaction.members.flatMap(member => member.deletionKeys);
    requireThat(requiredDeletionKeys.every(key => observation.deletionKeys.includes(key)), "missing-owner-deletion-alias");
    if (observation.kind === "returned-status" && observation.availability === "available") requireThat(observation.payload.index === item.responseIndex, "response-index-mismatch");
    if (observation.kind === "graph-status" && observation.availability === "available") {
        requireThat((item.kind === "graph-code-reference") === (observation.payload.evidenceLevel === "code-reference"), "evidence-unit-mismatch");
    }
    if (observation.kind === "duration" && observation.availability === "available") {
        requireThat((item.kind === "tool-call") === (observation.payload.boundary === "tool-start-to-completion"), "duration-unit-mismatch");
    }
    if (observation.origin === "optional-capture" && observation.availability === "available") {
        const context = observation.captureContext;
        requireThat(consent.state === "enabled" && consent.revision === context.consentRevision && consent.categories.includes(observation.kind), "stale-consent");
        requireThat(interaction.sourceConfigRef !== null && context.sourceConfigRef === interaction.sourceConfigRef
            && context.sourceConfigRef === consent.sourceConfigRef && context.sourceConfigRevision === consent.sourceConfigRevision
            && context.sourceConfigRevision === interaction.sourceConfigRevision, "stale-source");
        requireThat(observation.adapter === interaction.sourceAdapter, "capture-source-widening");
    }
    return observation;
}
export function validateConsent(value) {
    shape(value, {
        schemaVersion: version, policyVersion: literal(1), revision: integer,
        state: oneOf(["off", "enabled", "revoked"]), categories: list(oneOf(CAPTURE_CATEGORIES), 3),
        sourceConfigRef: nullable(ref), sourceConfigRevision: integer,
        grantedAt: nullableInstant, revokedAt: nullableInstant, grantOrigin: nullable(literal("explicit-in-app-setup")),
        limits: item => shape(item, Object.fromEntries(Object.entries(CAPTURE_LIMITS).map(([key, val]) => [key, literal(val)]))),
    });
    unique(value.categories);
    if (value.state === "enabled") {
        requireThat(value.revision > 0 && value.categories.length > 0 && value.sourceConfigRef !== null && value.grantedAt !== null && value.grantOrigin !== null && value.revokedAt === null, "invalid-consent");
    } else {
        requireThat(value.categories.length === 0, "inactive-consent-has-categories");
        if (value.state === "off") requireThat(value.grantedAt === null && value.grantOrigin === null && value.revokedAt === null, "invalid-default-consent");
        if (value.state === "revoked") requireThat(value.revision > 0 && value.grantedAt !== null && value.revokedAt !== null && value.grantOrigin !== null, "invalid-revocation");
    }
    return value;
}
export function defaultConsent() {
    return {
        schemaVersion: 1, policyVersion: 1, revision: 0, state: "off", categories: [],
        sourceConfigRef: null, sourceConfigRevision: 0, grantedAt: null, revokedAt: null, grantOrigin: null,
        limits: { ...CAPTURE_LIMITS },
    };
}
export function captureDecision(consent, request) {
    validateConsent(consent);
    shape(request, {
        category: oneOf(CAPTURE_CATEGORIES), adapter: oneOf(Object.keys(ADAPTER_CAPABILITIES)),
        expectedConsentRevision: integer, sourceConfigRef: ref, sourceConfigRevision: integer,
        sourceApproved: boolean, alreadyRecorded: boolean, credentialScreen: oneOf(["passed", "excluded", "not-run"]),
        utf8Bytes: integer, retainedItemCount: integer, retainedTotalBytes: integer,
    });
    const denied = reason => ({ allowed: false, reason });
    if (request.expectedConsentRevision !== consent.revision) return denied("stale-consent");
    if (consent.state !== "enabled") return denied("capture-disabled");
    if (!consent.categories.includes(request.category)) return denied("category-not-consented");
    if (!request.sourceApproved || !request.alreadyRecorded || request.sourceConfigRef !== consent.sourceConfigRef || request.sourceConfigRevision !== consent.sourceConfigRevision) return denied("stale-source");
    if (!ADAPTER_CAPABILITIES[request.adapter].includes(request.category)) return denied("unsupported-adapter");
    if (request.credentialScreen !== "passed") return denied("credential-excluded");
    if (request.utf8Bytes > consent.limits.bytesPerItem || request.retainedItemCount >= consent.limits.itemsPerInteraction
        || request.retainedTotalBytes + request.utf8Bytes > consent.limits.bytesPerInteraction) return denied("capture-limit");
    return { allowed: true, reason: null };
}
export function validateAssessment(value) {
    shape(value, {
        ...metadata, assessmentRef: ref, checkId: oneOf(Object.keys(RULES)), checkVersion: literal(1),
        dimension: oneOf([...DIMENSIONS, "execution", "evidence"]), unitRef: ref,
        origin: oneOf(["automatic-local", "user-personal", "model-assessed"]), rubricVersion: literal(1),
        ...(value?.origin === "model-assessed" ? { evaluator } : {}),
        verdict: oneOf(["pass", "fail", "unassessed", "evaluator-error"]), reason,
        revision: positive, supersedes: nullable(ref), withdrawn: boolean,
    });
    const rule = RULES[value.checkId];
    requireThat(rule.dimension === value.dimension, "check-dimension-mismatch");
    requireThat((rule.evaluator === "model") === (value.origin === "model-assessed"), "evaluator-origin-mismatch");
    if (["pass", "fail"].includes(value.verdict)) {
        requireThat(value.evidenceRefs.length > 0 || value.origin === "user-personal", "verdict-without-evidence");
        requireThat(value.reason === (value.origin === "user-personal" ? "user-verdict" : null), "invalid-verdict-reason");
    } else requireThat(value.reason !== null, "missing-unavailable-reason");
    requireThat(value.verdict !== "evaluator-error" || value.reason === "evaluator-failure", "invalid-evaluator-error");
    if (value.origin === "automatic-local") {
        requireThat(!value.withdrawn, "automatic-withdrawal");
        if (rule.observation === null) requireThat(value.verdict === "unassessed" && value.reason === "unsupported-check", "unsupported-semantic-verdict");
        if (value.checkId === "answer-evidence-present") requireThat(value.verdict !== "fail", "absence-is-not-negative-quality");
    } else if (value.origin === "model-assessed") {
        requireThat(value.unitRef === value.interactionRef && !value.withdrawn, "invalid-model-assessment-scope");
    } else {
        requireThat(["accuracy", "answer-trust", "action-trust"].includes(value.dimension) && value.unitRef === value.interactionRef, "invalid-personal-verdict-scope");
        requireThat(value.verdict !== "evaluator-error", "invalid-personal-verdict");
        if (value.withdrawn) requireThat(value.verdict === "unassessed" && value.reason === "user-withdrawn", "invalid-withdrawal");
    }
    return value;
}
export function evaluateCheck(checkId, observation) {
    requireThat(Object.hasOwn(RULES, checkId), "unknown-check");
    const rule = RULES[checkId];
    if (rule.observation === null) return { verdict: "unassessed", reason: "unsupported-check" };
    if (observation === null) return { verdict: "unassessed", reason: "missing-evidence" };
    validateObservation(observation);
    requireThat(observation.kind === rule.observation, "wrong-check-evidence");
    if (observation.availability !== "available") return { verdict: "unassessed", reason: observation.reason };
    const p = observation.payload;
    if (checkId === "answer-evidence-present") return { verdict: "pass", reason: null };
    if (checkId === "recorded-tool-success") {
        if (!p.completionRecorded) return { verdict: "unassessed", reason: "missing-completion" };
        if (p.toolSucceeded === null || p.reportedOutcome === "partial") return { verdict: "unassessed", reason: "nonbinary-outcome" };
        return { verdict: p.toolSucceeded ? "pass" : "fail", reason: null };
    }
    if (p.statusCode === null) return { verdict: "unassessed", reason: "missing-evidence" };
    return p.statusCode >= 200 && p.statusCode < 300 ? { verdict: "pass", reason: null }
        : p.statusCode >= 400 ? { verdict: "fail", reason: null } : { verdict: "unassessed", reason: "nonbinary-outcome" };
}
export function appendPersonalRevision(history, next) {
    history.forEach(validateAssessment); validateAssessment(next);
    const prior = history.at(-1);
    requireThat(next.origin === "user-personal" && next.revision === (prior?.revision ?? 0) + 1 && next.supersedes === (prior?.assessmentRef ?? null), "stale-override");
    if (prior) requireThat(prior.origin === next.origin && prior.interactionRef === next.interactionRef && prior.checkId === next.checkId, "override-target-mismatch");
    requireThat(!history.some(item => item.assessmentRef === next.assessmentRef), "duplicate-identity");
    return [...history, structuredClone(next)];
}
export function activeAssessment(automatic, history) {
    validateAssessment(automatic);
    requireThat(automatic.origin === "automatic-local", "invalid-automatic-origin");
    let verified = [];
    for (const item of history) verified = appendPersonalRevision(verified, item);
    const latest = verified.at(-1);
    if (latest) {
        requireThat(latest.interactionRef === automatic.interactionRef && latest.checkId === automatic.checkId, "override-target-mismatch");
        for (const key of ["sourceRevision", "membershipRevision", "consentRevision", "deletionEpoch"]) {
            requireThat(latest.basis[key] === automatic.basis[key], `stale-${key}`);
        }
    }
    return structuredClone(latest && !latest.withdrawn ? latest : automatic);
}
const counts = value => shape(value, { pass: integer, fail: integer, unassessed: integer, evaluatorError: integer });
const sample = value => shape(value, { unitRef: ref, value: number, evidenceRefs: refs });
const pricing = nullable(value => shape(value, {
    method: oneOf(["recorded-charge", "versioned-rate-card"]), reference: ref, version: positive,
    attribution: literal("explicit-scope"), usageRefs: refs,
}));
export function validateMetric(value) {
    shape(value, {
        schemaVersion: version, metricRef: ref, definitionId: oneOf(Object.keys(DEFINITIONS)), definitionVersion: literal(1),
        dimension: oneOf([...DIMENSIONS, "execution", "evidence"]), checkId: nullable(oneOf(Object.keys(RULES))), checkVersion: nullable(literal(1)),
        unit: oneOf(["ratio", "ms", "USD"]), boundary: value => requireThat(typeof value === "string", "invalid-boundary"),
        measurementBasis: value => requireThat(typeof value === "string", "invalid-basis"), basis: validateBasis,
        origin: oneOf(["automatic-local", "user-personal", "model-assessed"]),
        ...(value?.origin === "model-assessed" ? { evaluator } : {}),
        status: oneOf(["measured", "estimated", "unpriced", "not-measured", "unassessed", "evaluator-error"]),
        value: nullable(number), reason, numerator: nullable(integer), denominator: nullable(integer),
        coverage, counts: nullable(counts), samples: list(sample), pricing,
        eligibleUnitRefs: refs, coveredUnitRefs: refs, evidenceRefs: refs, createdAt: instant,
        observedTime: item => shape(item, {
            state: oneOf(["available", "unavailable", "withheld"]), firstAt: nullableInstant, lastAt: nullableInstant,
            datedUnits: integer, undatedUnits: integer,
        }),
    });
    const definition = DEFINITIONS[value.definitionId];
    requireThat(value.unit === definition.unit && value.boundary === definition.boundary && value.measurementBasis === definition.basis, "definition-mismatch");
    requireThat(value.coverage.eligible === value.eligibleUnitRefs.length && value.coverage.covered === value.coveredUnitRefs.length
        && value.coveredUnitRefs.every(item => value.eligibleUnitRefs.includes(item)), "coverage-membership-mismatch");
    requireThat(value.observedTime.datedUnits + value.observedTime.undatedUnits === value.coverage.eligible, "time-coverage-mismatch");
    if (value.observedTime.state === "available") requireThat(value.observedTime.datedUnits > 0 && value.observedTime.firstAt !== null
        && value.observedTime.lastAt !== null && value.observedTime.firstAt <= value.observedTime.lastAt, "invalid-observed-time");
    else requireThat(value.observedTime.firstAt === null && value.observedTime.lastAt === null
        && (value.observedTime.state === "withheld" || value.observedTime.datedUnits === 0), "unavailable-time-has-value");
    if (["measured", "estimated"].includes(value.status)) {
        requireThat(value.value !== null && value.reason === null && value.coverage.covered > 0 && value.evidenceRefs.length > 0, "measurement-without-evidence");
    } else requireThat(value.value === null && value.reason !== null, "unavailable-has-value");
    if (definition.form === "counts") {
        requireThat(value.checkId !== null && value.checkVersion === RULES[value.checkId].version && value.dimension === RULES[value.checkId].dimension, "check-definition-mismatch");
        requireThat((RULES[value.checkId].evaluator === "model") === (value.origin === "model-assessed"), "evaluator-origin-mismatch");
        counts(value.counts);
        requireThat(Object.values(value.counts).reduce((a, b) => a + b, 0) === value.coverage.eligible
            && value.counts.pass + value.counts.fail === value.coverage.covered, "impossible-counts");
        requireThat(value.numerator === value.counts.pass && value.denominator === value.coverage.covered, "invalid-denominator");
        requireThat(value.samples.length === 0 && value.pricing === null, "invalid-count-payload");
        if (value.denominator > 0) requireThat(value.status === "measured" && value.value === value.numerator / value.denominator, "invalid-ratio");
        else requireThat(["unassessed", "evaluator-error"].includes(value.status), "empty-ratio-is-not-zero");
        if (value.status === "evaluator-error") requireThat(value.counts.evaluatorError > 0 && value.reason === "evaluator-failure", "invalid-evaluator-error");
        if (value.origin === "automatic-local" && RULES[value.checkId].observation === null) requireThat(value.coverage.covered === 0, "unsupported-semantic-verdict");
        if (value.origin === "user-personal") requireThat(["accuracy", "answer-trust", "action-trust"].includes(value.dimension), "invalid-personal-verdict-scope");
    } else {
        requireThat(value.checkId === null && value.checkVersion === null && value.counts === null && value.numerator === null && value.denominator === null, "invalid-noncount-payload");
        requireThat(value.dimension === (definition.form === "cost" ? "cost" : "speed"), "definition-dimension-mismatch");
        requireThat(value.origin === "automatic-local", "invalid-measurement-origin");
        if (definition.form === "samples") {
            requireThat(value.pricing === null && value.samples.length === value.coverage.covered, "invalid-duration-payload");
            unique(value.samples.map(item => item.unitRef));
            requireThat(value.samples.every(item => value.coveredUnitRefs.includes(item.unitRef) && item.evidenceRefs.length > 0), "sample-membership-mismatch");
            const sorted = value.samples.map(item => item.value).sort((a, b) => a - b);
            requireThat(sorted.length ? value.status === "measured" && value.value === sorted[Math.ceil(sorted.length / 2) - 1]
                : value.status === "not-measured", "invalid-nearest-rank-p50");
        } else if (definition.form === "unsupported") {
            requireThat(value.status === "not-measured" && value.samples.length === 0 && value.coverage.covered === 0 && value.pricing === null, "unsupported-task-latency");
        } else {
            requireThat(value.samples.length === 0 && ["measured", "estimated", "unpriced", "not-measured"].includes(value.status), "invalid-cost-state");
            if (["measured", "estimated"].includes(value.status)) {
                requireThat(value.pricing !== null && value.pricing.method === (value.status === "measured" ? "recorded-charge" : "versioned-rate-card")
                    && value.pricing.usageRefs.length > 0, "cost-without-attribution");
            } else {
                requireThat(value.pricing === null && value.coverage.covered === 0, "unavailable-cost-payload");
                requireThat(value.reason === (value.status === "unpriced" ? "pricing-unavailable" : "usage-unavailable"), "invalid-cost-reason");
            }
        }
    }
    return value;
}
export function metricSlotKey(value) {
    validateMetric(value);
    return JSON.stringify([
        value.dimension, value.definitionId, value.checkId, value.origin,
        ...(value.origin === "model-assessed" ? [value.evaluator.provider, value.evaluator.model, value.evaluator.rubricId, value.evaluator.rubricVersion] : []),
        ...(DEFINITIONS[value.definitionId].form === "cost" ? [
            value.status,
            value.pricing ? [value.pricing.method, value.pricing.reference, value.pricing.version, value.pricing.attribution] : null,
        ] : []),
    ]);
}
// Pooling is deliberately not report comparison: callers must supply disjoint exact membership.
export function poolMetrics(values, metricRef, createdAt) {
    requireThat(values.length > 0, "empty-pool");
    values.forEach(validateMetric); ref(metricRef); instant(createdAt);
    const first = values[0], definition = DEFINITIONS[first.definitionId];
    const signature = value => JSON.stringify([metricSlotKey(value), value.definitionVersion, value.checkVersion, value.unit, value.boundary, value.measurementBasis, value.basis]);
    requireThat(values.every(value => signature(value) === signature(first)), "incompatible-definitions");
    const eligibleUnitRefs = values.flatMap(value => value.eligibleUnitRefs);
    unique(eligibleUnitRefs);
    const result = structuredClone(first);
    Object.assign(result, {
        metricRef, createdAt, eligibleUnitRefs, coveredUnitRefs: values.flatMap(value => value.coveredUnitRefs),
        evidenceRefs: [...new Set(values.flatMap(value => value.evidenceRefs))],
        coverage: { eligible: eligibleUnitRefs.length, covered: values.reduce((sum, value) => sum + value.coverage.covered, 0) },
    });
    const times = values.map(value => value.observedTime);
    const withheld = times.some(value => value.state === "withheld"), available = times.filter(value => value.state === "available");
    result.observedTime = {
        state: withheld ? "withheld" : available.length ? "available" : "unavailable",
        firstAt: !withheld && available.length ? available.map(value => value.firstAt).sort()[0] : null,
        lastAt: !withheld && available.length ? available.map(value => value.lastAt).sort().at(-1) : null,
        datedUnits: times.reduce((sum, value) => sum + value.datedUnits, 0),
        undatedUnits: times.reduce((sum, value) => sum + value.undatedUnits, 0),
    };
    if (definition.form === "counts") {
        result.counts = Object.fromEntries(Object.keys(first.counts).map(key => [key, values.reduce((sum, value) => sum + value.counts[key], 0)]));
        result.numerator = result.counts.pass; result.denominator = result.coverage.covered;
        result.value = result.denominator ? result.numerator / result.denominator : null;
        result.status = result.denominator ? "measured" : result.counts.evaluatorError ? "evaluator-error" : "unassessed";
        result.reason = result.denominator ? null : result.counts.evaluatorError ? "evaluator-failure"
            : values.every(value => value.reason === first.reason) ? first.reason : "no-assessed-units";
    } else if (definition.form === "samples") {
        result.samples = values.flatMap(value => value.samples);
        const sorted = result.samples.map(item => item.value).sort((a, b) => a - b);
        result.value = sorted.length ? sorted[Math.ceil(sorted.length / 2) - 1] : null;
        result.status = sorted.length ? "measured" : "not-measured";
        result.reason = sorted.length ? null : "missing-evidence";
    } else if (definition.form === "cost" && ["measured", "estimated"].includes(first.status)) {
        const usageRefs = values.flatMap(value => value.pricing.usageRefs);
        unique(usageRefs);
        result.value = values.reduce((sum, value) => sum + value.value, 0);
        result.pricing.usageRefs = usageRefs;
    }
    return validateMetric(result);
}
export function validateDependencies(value) {
    shape(value, { interactionRefs: refs, recordRefs: refs, evidenceRefs: refs, deletionKeys: hashes, basis: validateBasis });
    requireThat(value.interactionRefs.length > 0 && value.recordRefs.length > 0 && value.deletionKeys.length > 0, "missing-dependency");
    return value;
}
export function validateStoredAssessment(value) {
    shape(value, { schemaVersion: version, assessment: validateAssessment, dependencies: validateDependencies });
    const { assessment, dependencies } = value;
    requireThat(dependencies.interactionRefs.includes(assessment.interactionRef)
        && assessment.evidenceRefs.every(ref => dependencies.evidenceRefs.includes(ref)), "assessment-dependency-mismatch");
    if (assessment.unitRef !== assessment.interactionRef) requireThat(dependencies.recordRefs.includes(assessment.unitRef), "assessment-dependency-mismatch");
    for (const key of BASIS_KEYS) requireThat(assessment.basis[key] === dependencies.basis[key], `stale-${key}`);
    return value;
}
export function validateAssessmentStore(value) {
    shape(value, { schemaVersion: version, revision: integer, records: list(validateStoredAssessment) });
    unique(value.records.map(item => item.assessment.assessmentRef));
    const histories = new Map();
    for (const { assessment } of value.records) {
        const key = `${assessment.interactionRef}:${assessment.checkId}:${assessment.origin}`;
        const history = histories.get(key) ?? [];
        const prior = history.at(-1);
        requireThat(assessment.revision === (prior?.revision ?? 0) + 1 && assessment.supersedes === (prior?.assessmentRef ?? null), "invalid-history-chain");
        history.push(assessment); histories.set(key, history);
    }
    return value;
}
export function validateReviewStatus(value) {
    shape(value, {
        schemaVersion: version,
        execution: value => {
            shape(value, { calls: integer, succeeded: integer, failed: integer, other: integer,
                causes: list(value => shape(value, {
                    cause: oneOf(["workiq-sign-in-required", "request-timeout", "access-denial", "message-screened",
                        "message-too-large", "message-not-supplied", "message-excluded", "unsupported-error-format",
                        "source-error-not-supplied", "unqualified"]),
                    count: positive,
                }), 10) });
            unique(value.causes.map(item => item.cause));
            requireThat(value.calls === value.succeeded + value.failed + value.other
                && value.causes.reduce((sum, item) => sum + item.count, 0) === value.failed, "invalid-execution-summary");
        },
        assessment: value => shape(value, {
            result: oneOf(["none", "assessed", "partial", "unassessed"]),
            unavailableReason: nullable(oneOf(["missing-evidence", "not-applicable", "other-unavailable"])),
            latestAttempt: oneOf(["none", "pending", "failed", "uncertain", "unavailable", "complete", "revoked", "not-run", "not-current"]),
            inAutomaticScope: boolean, personalFeedback: boolean,
        }),
    });
    requireThat(["none", "assessed"].includes(value.assessment.result)
        ? value.assessment.unavailableReason === null : value.assessment.unavailableReason !== null, "invalid-review-unavailable-reason");
    return value;
}
export function validateInteractionView(value) {
    shape(value, {
        schemaVersion: version, basis: validateBasis, interaction: validateInteraction,
        consent: validateConsent, observations: list(validateObservation), assessments: list(validateAssessment), metrics: list(validateMetric),
        ...(Object.hasOwn(value, "reviewStatus") ? { reviewStatus: validateReviewStatus } : {}),
    });
    for (const key of BASIS_KEYS) requireThat(value.interaction.basis[key] === value.basis[key], `stale-${key}`);
    unique(value.observations.map(item => item.observationRef)); unique(value.assessments.map(item => item.assessmentRef));
    unique(value.metrics.map(item => item.metricRef));
    const members = new Set(value.interaction.members.map(item => item.ref)), allowed = new Set([value.interaction.interactionRef, ...members]);
    for (const item of value.observations) validateObservationForInteraction(item, value.interaction, value.consent);
    for (const item of [...value.assessments, ...value.metrics]) {
        for (const key of BASIS_KEYS) requireThat(item.basis[key] === value.basis[key], `stale-${key}`);
    }
    for (const item of value.assessments) requireThat(item.interactionRef === value.interaction.interactionRef && allowed.has(item.unitRef), "assessment-outside-interaction");
    for (const item of value.metrics) requireThat(item.eligibleUnitRefs.every(ref => allowed.has(ref)), "metric-outside-interaction");
    if (value.reviewStatus) {
        requireThat(value.reviewStatus.execution.calls === value.interaction.members.filter(item => item.kind === "tool-call").length, "execution-summary-outside-interaction");
        const model = value.metrics.filter(item => item.origin === "model-assessed"
            && ["accuracy", "answer-trust", "action-trust"].includes(item.dimension));
        const result = !model.length ? "none" : model.every(item => item.value !== null) ? "assessed"
            : model.some(item => item.value !== null) ? "partial" : "unassessed";
        requireThat(value.reviewStatus.assessment.result === result, "review-summary-result-mismatch");
        requireThat(value.reviewStatus.assessment.personalFeedback === value.assessments.some(item => item.origin === "user-personal"), "review-summary-feedback-mismatch");
    }
    return value;
}
export function assertCurrent(dependencies, current) {
    validateDependencies(dependencies);
    shape(current, { basis: validateBasis, pendingCleanup: boolean, retainedRecordRefs: refs, removedIdentityHashes: hashes });
    requireThat(!current.pendingCleanup, "deletion-pending");
    for (const key of BASIS_KEYS) requireThat(dependencies.basis[key] === current.basis[key], `stale-${key}`);
    requireThat(dependencies.recordRefs.every(item => current.retainedRecordRefs.includes(item)), "deleted-dependency");
    requireThat(!dependencies.deletionKeys.some(item => current.removedIdentityHashes.includes(item)), "deleted-dependency");
    return true;
}
export function affectedDerivedRefs(entries, removedHashes, revokedConsentRevision = null) {
    hashes(removedHashes); nullable(integer)(revokedConsentRevision);
    return entries.filter(entry => {
        shape(entry, { ref, dependencies: validateDependencies });
        return entry.dependencies.deletionKeys.some(item => removedHashes.includes(item))
            || revokedConsentRevision !== null && entry.dependencies.basis.consentRevision === revokedConsentRevision;
    }).map(entry => entry.ref);
}
export const WORKIQ_TOOLS = Object.freeze(["ask", "list_agents", "retrieve", "search_paths", "get_schema", "fetch", "fetch_blob", "call_function", "do_action", "create_entity", "update_entity", "delete_entity"].map(name => `workiq-${name}`));
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const QUERY_KEYS = ["$select", "$filter", "$search", "$orderby", "$top", "$skip", "$skiptoken", "$expand", "$count", "$format", "$deltatoken", "startDateTime", "endDateTime", "{query-key}"];
const WORKLOADS = ["Mail", "Calendar", "Files", "Teams", "People", "Tasks", "Notes", "Directory", "Search", "Discovery", "Multiple workloads", "Platform metadata", "Unknown"];
const boundedText = value => requireThat(typeof value === "string" && value.length <= 2048, "invalid-projected-text");
function endpoint(value) {
    shape(value, {
        pathTemplate: boundedText, method: nullable(oneOf(METHODS)), apiVersion: nullable(oneOf(["v1.0", "beta"])),
        queryKeys: list(oneOf(QUERY_KEYS), QUERY_KEYS.length),
    });
    unique(value.queryKeys);
}
function pattern(value) {
    shape(value, {
        version: oneOf([1, 2, 3]), normalizer: oneOf(["wire-safe-technical-pattern-v1", "wire-safe-technical-pattern-v2", "wire-safe-technical-pattern-v3"]), key: hash,
        unitKind: kindCheck, toolClass: oneOf(["workiq", "graph-mcp", "shell", "script-reference", "owned-http", "unknown"]),
        method: nullable(oneOf(METHODS)),
        apiVersion: nullable(oneOf(["v1.0", "beta"])), targetShape: oneOf(["single", "multiple", "unavailable"]),
        display: item => shape(item, {
            tool: oneOf([...WORKIQ_TOOLS, "graph-mcp", "shell", "script-reference", "owned-http", "unknown"]),
            workload: oneOf(WORKLOADS), attribution: oneOf(["requested-single-target", "requested-batch-targets", "returned-entry-unattributed", "recorded-site", "owned-request", "unavailable", "schema-reference", "discovery"]),
            endpoints: list(endpoint, 100),
        }),
    });
    const expectedClass = value.display.tool.startsWith("workiq-") ? "workiq" : value.display.tool;
    requireThat(value.normalizer === `wire-safe-technical-pattern-v${value.version}`, "pattern-version-mismatch");
    if (value.version === 1) requireThat(value.display.workload !== "Discovery"
        && !["schema-reference", "discovery"].includes(value.display.attribution), "category-definition-mismatch");
    if (value.version < 3) requireThat(!value.display.endpoints.some(endpoint => endpoint.pathTemplate === "/shares/{id}/driveItem"),
        "category-definition-mismatch");
    if (value.display.workload === "Discovery") requireThat(value.unitKind === "tool-call"
        && ["workiq-search_paths", "workiq-get_schema", "workiq-list_agents"].includes(value.display.tool), "discovery-requires-preparatory-tool");
    if (["schema-reference", "discovery"].includes(value.display.attribution)) requireThat(value.display.workload === "Discovery"
        && (value.display.attribution === "schema-reference") === (value.display.tool === "workiq-get_schema"), "discovery-attribution-mismatch");
    requireThat(value.toolClass === expectedClass, "tool-class-mismatch");
    requireThat(value.targetShape !== "unavailable" || value.display.endpoints.length === 0, "unavailable-target-has-endpoint");
}
function recordedOutcome(value) {
    shape(value, {
        memberRef: ref, kind: kindCheck, definitionVersion: literal(1),
        outcome: oneOf(["success", "failure", "partial", "unknown", "other", "transport"]),
        outcomeBasis: oneOf(["recorded-tool-outcome", "numeric-returned-status", "reported-symbolic-error", "owned-response", "owned-transport-error", "output-visible-status", "no-status"]),
        statusCode, evidenceRefs: refs,
    });
    requireThat(value.kind !== "graph-code-reference", "code-reference-is-not-execution");
    requireThat(value.evidenceRefs.length > 0, "missing-evidence-reference");
    if (value.kind === "tool-call") {
        requireThat(value.outcomeBasis === "recorded-tool-outcome" && value.statusCode === null
            && ["success", "failure", "partial", "unknown"].includes(value.outcome), "invalid-tool-outcome");
    } else if (value.outcomeBasis === "no-status") {
        requireThat(value.outcome === "unknown" && value.statusCode === null, "invalid-missing-status");
    } else if (value.outcomeBasis === "reported-symbolic-error") {
        requireThat(value.kind === "returned-api-entry" && value.outcome === "failure" && value.statusCode === null, "invalid-symbolic-error");
    } else if (value.outcomeBasis === "owned-transport-error") {
        requireThat(value.kind === "owned-http" && value.outcome === "transport" && value.statusCode === null, "invalid-transport-outcome");
    } else {
        const basis = { "returned-api-entry": "numeric-returned-status", "owned-http": "owned-response", "graph-request-site": "output-visible-status" }[value.kind];
        requireThat(value.outcomeBasis === basis && value.statusCode !== null, "invalid-status-basis");
        const expected = value.statusCode >= 200 && value.statusCode < 300 ? "success" : value.statusCode >= 400 ? "failure" : "other";
        requireThat(value.outcome === expected, "status-outcome-mismatch");
    }
}
export function validateReportFacts(value, { validateEndpoint } = {}) {
    shape(value, {
        schemaVersion: version, contractVersion: literal(CONTRACT_VERSION), snapshotRef: ref, preparedAt: instant,
        ...(value != null && Object.hasOwn(value, "metricProjectionVersion") ? { metricProjectionVersion: literal(METRIC_PROJECTION_VERSION) } : {}),
        namespace: item => shape(item, { ref, version: literal(1), identityScheme: literal("keyed-report-pseudonyms-v1") }),
        basis: validateBasis,
        scope: item => shape(item, {
            kind: oneOf(["all", "current", "selected"]), membership: oneOf(["exact-retained", "partial-retained"]),
            from: nullableInstant, untilExclusive: nullableInstant,
            timeZone: zone => { requireThat(typeof zone === "string", "invalid-timezone"); try { new Intl.DateTimeFormat("en", { timeZone: zone }); } catch { throw new ContractError("invalid-timezone"); } },
        }),
        memberships: list(item => shape(item, {
            interactionRef: ref, membershipRevision: integer, status: oneOf(["complete-retained", "partial", "unverified"]),
            members: list(item => shape(item, { ref, kind: kindCheck })),
        })),
        metrics: list(validateMetric), assessments: list(validateAssessment), recordedOutcomes: list(recordedOutcome),
        patterns: list(item => shape(item, { pattern, memberRefs: refs })),
        privacyProjectionVersion: literal(1),
    });
    if (value.metricProjectionVersion === METRIC_PROJECTION_VERSION) {
        requireThat([...value.metrics, ...value.assessments].every(item => item.dimension !== "cost"), "retired-current-metric");
    }
    if (value.scope.from && value.scope.untilExclusive) requireThat(value.scope.from < value.scope.untilExclusive, "invalid-date-range");
    unique(value.memberships.map(item => item.interactionRef));
    const memberRefs = value.memberships.flatMap(item => item.members.map(member => member.ref));
    unique(memberRefs); unique(value.metrics.map(item => item.metricRef)); unique(value.metrics.map(metricSlotKey));
    unique(value.assessments.map(item => item.assessmentRef));
    const interactions = value.memberships.map(item => item.interactionRef), allowed = new Set([...interactions, ...memberRefs]);
    const members = new Map(value.memberships.flatMap(item => item.members.map(member => [member.ref, member.kind])));
    unique(value.recordedOutcomes.map(item => item.memberRef));
    const expectedOutcomes = [...members].filter(([, kind]) => kind !== "graph-code-reference");
    requireThat(value.recordedOutcomes.length === expectedOutcomes.length
        && value.recordedOutcomes.every(item => members.get(item.memberRef) === item.kind), "outcome-membership-mismatch");
    for (const item of [...value.metrics, ...value.assessments]) {
        for (const key of BASIS_KEYS) requireThat(item.basis[key] === value.basis[key], `stale-${key}`);
    }
    for (const item of value.metrics) {
        requireThat(item.eligibleUnitRefs.every(ref => allowed.has(ref)), "metric-outside-frozen-membership");
        requireThat(item.observedTime.state !== "available", "raw-source-times-not-report-facts");
    }
    for (const item of value.assessments) {
        const membership = value.memberships.find(group => group.interactionRef === item.interactionRef);
        requireThat(membership && (item.unitRef === item.interactionRef || membership.members.some(member => member.ref === item.unitRef)), "assessment-outside-frozen-membership");
    }
    unique(value.patterns.flatMap(item => item.memberRefs));
    requireThat(new Set(value.patterns.map(item => item.pattern.version)).size <= 1, "mixed-pattern-definitions");
    for (const item of value.patterns) {
        requireThat(item.memberRefs.every(ref => members.get(ref) === item.pattern.unitKind), "pattern-outside-frozen-membership");
        for (const endpoint of item.pattern.display.endpoints) {
            requireThat(typeof validateEndpoint === "function", "trusted-endpoint-validator-required");
            requireThat(validateEndpoint(endpoint) === true, "unsafe-endpoint-projection");
        }
    }
    requireThat(value.scope.membership !== "exact-retained" || value.memberships.every(item => item.status === "complete-retained"), "overstated-membership");
    return value;
}
function deepFreeze(value) {
    if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
    return value;
}
export function freezeReportFacts(value, options) {
    validateReportFacts(value, options);
    return deepFreeze(structuredClone(value));
}
export const REQUESTS = Object.freeze({
    get_interaction: { mutation: false, fields: { schemaVersion: version, interactionRef: ref, expectedSourceRevision: integer } },
    get_interaction_evidence: { mutation: false, fields: { schemaVersion: version, interactionRef: ref, observationRef: ref, expectedBasis: validateBasis } },
    get_assessment_overview: { mutation: false, fields: { schemaVersion: version, interactionRefs: refs, expectedSourceRevision: integer } },
    get_assessment_consent: { mutation: false, fields: { schemaVersion: version } },
    set_assessment_consent: { mutation: true, fields: {
        schemaVersion: version, mutationRef: ref, expectedSourceRevision: integer, expectedConsentRevision: integer,
        policyVersion: literal(1), enabled: boolean, categories: list(oneOf(CAPTURE_CATEGORIES), 3), sourceConfigRef: ref, sourceConfigRevision: integer, confirmed: literal(true),
    } },
    set_personal_assessment: { mutation: true, fields: {
        schemaVersion: version, mutationRef: ref, interactionRef: ref, expectedBasis: validateBasis,
        checkId: oneOf(["semantic-answer-correctness", "answer-support-validity", "action-authorization-compliance"]),
        verdict: oneOf(["pass", "fail", "unassessed"]), withdraw: boolean,
    } },
    get_mutation_status: { mutation: false, fields: { schemaVersion: version, mutationRef: ref } },
});
export function validateRequest(action, input) {
    requireThat(Object.hasOwn(REQUESTS, action), "unknown-action");
    const recoverable = ["set_personal_assessment", "set_assessment_consent", "get_mutation_status"].includes(action);
    const fields = recoverable && input?.receiptToken !== undefined ? { ...REQUESTS[action].fields, receiptToken: hash } : REQUESTS[action].fields;
    shape(input, fields);
    if (action === "set_assessment_consent") {
        unique(input.categories);
        requireThat(input.enabled ? input.categories.length > 0 : input.categories.length === 0, "invalid-consent-categories");
    }
    if (action === "set_personal_assessment" && input.withdraw) requireThat(input.verdict === "unassessed", "invalid-withdrawal");
    return input;
}
