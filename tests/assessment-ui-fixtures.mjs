import * as contract from "../lib/assessment-contract.mjs";
import { buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { fixture, selectActivityOption } from "./helpers.mjs";
export { contract };
export async function openPersonalFeedback(page, check = "semantic-answer-correctness") {
    const reviews = page.locator('[data-reader-section="reviews"]');
    await reviews.getByRole("button", { name: "Personal feedback", exact: true }).click();
    const select = reviews.locator("select[data-feedback-dimension]");
    await selectActivityOption(page, await select.getAttribute("id"), check);
    return reviews.locator(".assessment-feedback-dialog");
}
const at = "2026-10-06T12:00:00.000Z";
const id = (kind, n = 1) => `${kind}-${n.toString(16).padStart(32, "0")}`;
const basis = () => ({ sourceRevision: 7, membershipRevision: 2, consentRevision: 0, overrideRevision: 0, deletionEpoch: 1 });
function metricBase(definitionId, eligible = 1, offset = 0) {
    const definition = contract.DEFINITIONS[definitionId];
    return {
        schemaVersion: 1, metricRef: id("metric", offset + 1), definitionId, definitionVersion: 1,
        dimension: definition.form === "cost" ? "cost" : "speed", checkId: null, checkVersion: null,
        unit: definition.unit, boundary: definition.boundary, measurementBasis: definition.basis, basis: basis(),
        origin: "automatic-local", status: "not-measured", value: null, reason: "missing-evidence", numerator: null, denominator: null,
        coverage: { covered: 0, eligible }, counts: null, samples: [], pricing: null,
        eligibleUnitRefs: Array.from({ length: eligible }, (_, index) => id("record", offset + index + 1)),
        coveredUnitRefs: [], evidenceRefs: [], createdAt: at,
        observedTime: { state: "unavailable", firstAt: null, lastAt: null, datedUnits: 0, undatedUnits: eligible },
    };
}
function makeRatio(pass = 1, fail = 0, unassessed = 0, evaluatorError = 0, offset = 0) {
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
function makeDuration(values = [1000], offset = 0) {
    const base = metricBase("tool-duration", values.length, offset), sorted = [...values].sort((a, b) => a - b);
    return {
        ...base, coverage: { covered: values.length, eligible: values.length }, coveredUnitRefs: [...base.eligibleUnitRefs],
        samples: values.map((value, index) => ({ unitRef: base.eligibleUnitRefs[index], value, evidenceRefs: [id("evidence", offset + index + 1)] })),
        evidenceRefs: values.map((_, index) => id("evidence", offset + index + 1)),
        status: values.length ? "measured" : "not-measured", value: sorted.length ? sorted[Math.ceil(sorted.length / 2) - 1] : null,
        reason: values.length ? null : "missing-evidence",
    };
}
function makeCost(state = "not-measured") {
    const base = metricBase("attributed-cost"), priced = ["measured", "estimated"].includes(state);
    return {
        ...base, status: state, value: priced ? 0.25 : null, reason: priced ? null : state === "unpriced" ? "pricing-unavailable" : "usage-unavailable",
        coverage: { covered: priced ? 1 : 0, eligible: 1 }, coveredUnitRefs: priced ? [...base.eligibleUnitRefs] : [],
        evidenceRefs: priced || state === "unpriced" ? [id("usage")] : [],
        pricing: priced ? { method: state === "measured" ? "recorded-charge" : "versioned-rate-card", reference: id("price"), version: 1, attribution: "explicit-scope", usageRefs: [id("usage")] } : null,
    };
}
function makeAssessment(personal = false) {
    return {
        schemaVersion: 1, interactionRef: id("interaction"), basis: basis(), createdAt: at, evidenceRefs: [],
        assessmentRef: id("assessment", personal ? 2 : 1), checkId: "semantic-answer-correctness", checkVersion: 1,
        dimension: "accuracy", unitRef: id("interaction"), origin: personal ? "user-personal" : "automatic-local", rubricVersion: 1,
        verdict: personal ? "pass" : "unassessed", reason: personal ? "user-verdict" : "unsupported-check",
        revision: 1, supersedes: null, withdrawn: false,
    };
}
function enabledConsent() {
    return {
        ...contract.defaultConsent(), revision: 1, state: "enabled", categories: ["answer", "usage", "explicit-authorization"],
        sourceConfigRef: id("config"), sourceConfigRevision: 1, grantedAt: at, grantOrigin: "explicit-in-app-setup",
    };
}
export const samples = { id, at, basis, metricBase, makeRatio, makeDuration, makeCost, makeAssessment, enabledConsent };
export function retainedResponse(text, record) {
    const model = buildAssessmentModel({ revision: 1, pseudonymKey: "a".repeat(64), evidence: [record], exports: [] });
    const view = [...model.details.values()][0], consent = { ...enabledConsent(), categories: ["answer"] };
    view.basis.consentRevision = 1;
    for (const item of [view.interaction, ...view.observations, ...view.assessments, ...view.metrics]) item.basis = { ...view.basis };
    Object.assign(view.interaction, { sourceConfigRef: consent.sourceConfigRef, sourceConfigRevision: consent.sourceConfigRevision });
    view.consent = consent;
    view.observations.push({
        schemaVersion: 1, interactionRef: view.interaction.interactionRef, basis: { ...view.basis },
        createdAt: at, evidenceRefs: [id("evidence", 80)], observationRef: id("observation", 80),
        memberRef: null, adapter: "copilot-local-events-v1", kind: "answer", origin: "optional-capture",
        availability: "available", reason: null, occurredAt: at, sourceEventRefs: [id("event", 80)],
        deletionKeys: [...new Set(view.interaction.members.flatMap(member => member.deletionKeys))],
        payload: { textRef: id("text", 80), utf8Bytes: Buffer.byteLength(text), completeness: "bounded-fragment", finality: "unverified", credentialScreenVersion: 1, credentialScreen: "passed" },
        captureContext: { consentRevision: 1, sourceConfigRef: consent.sourceConfigRef, sourceConfigRevision: consent.sourceConfigRevision },
    });
    return contract.validateInteractionView(view);
}
export function quality(dimension, { pass = 0, fail = 0, unassessed = 1, personal = false, offset = 0 } = {}) {
    const metric = makeRatio(pass, fail, unassessed, 0, offset);
    metric.dimension = dimension;
    metric.checkId = { accuracy: "semantic-answer-correctness", "answer-trust": "answer-support-validity", "action-trust": "action-authorization-compliance" }[dimension];
    metric.origin = personal ? "user-personal" : "automatic-local";
    metric.metricRef = id("metric", 100 + ["accuracy", "answer-trust", "action-trust"].indexOf(dimension) + offset);
    metric.eligibleUnitRefs = Array.from({ length: pass + fail + unassessed }, (_, index) => id("interaction", offset + index + 1));
    metric.coveredUnitRefs = metric.eligibleUnitRefs.slice(0, pass + fail);
    if (!personal) metric.reason = "unsupported-check";
    return contract.validateMetric(metric);
}
export function currentView() {
    const record = fixture("presentation");
    record.userPrompt.sourceEventId = "artificial-message";
    Object.assign(record.toolCalls[0], {
        completionEventId: "artificial-completion", startedAt: at,
        completedAt: "2026-10-06T12:00:01.042Z", durationMs: 1042,
    });
    const model = buildAssessmentModel({ revision: 7, pseudonymKey: "a".repeat(64), evidence: [record], exports: [] });
    return contract.validateInteractionView([...model.details.values()][0]);
}
export function mixedOverview() {
    const metrics = [
        quality("accuracy"), quality("answer-trust"), quality("action-trust"),
        makeDuration([1042]), makeCost(), makeRatio(),
        quality("accuracy", { pass: 3, fail: 1, unassessed: 4, personal: true, offset: 20 }),
        quality("answer-trust", { pass: 1, fail: 1, unassessed: 6, personal: true, offset: 40 }),
        quality("action-trust", { pass: 9, fail: 1, unassessed: 2, personal: true, offset: 60 }),
    ];
    for (const [index, state] of ["measured", "estimated", "unpriced"].entries()) {
        const metric = makeCost(state); metric.metricRef = id("metric", 180 + index); metrics.push(metric);
    }
    return metrics;
}
