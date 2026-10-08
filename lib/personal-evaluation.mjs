import { defaultConsent, validateConsent, validateObservation, validateDependencies, validateAssessmentStore, validateAssessment, validateBasis, ContractError } from "./assessment-contract.mjs";
import { validateModelEvaluationState } from "./model-evaluation-state.mjs";

const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const ref = value => typeof value === "string" && /^[a-z]+-[a-f0-9]{32}$/.test(value);
const assert = (condition, code) => { if (!condition) throw new ContractError(code); };
function object(value, keys) {
    assert(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)), "invalid-personal-evaluation-shape");
}
export function defaultPersonalEvaluation() {
    return {
        schemaVersion: 1, consent: defaultConsent(), source: { available: false, sourceConfigRef: null, sourceConfigRevision: 0 },
        overrideRevision: 0, captures: [], feedback: { schemaVersion: 1, revision: 0, records: [] },
        mutations: {}, suppressedCaptures: [],
    };
}
export function validateCaptureKeys(value) {
    assert(Array.isArray(value) && value.length > 0 && value.length <= 20, "invalid-capture-keys");
    for (const key of value) { object(key, ["category", "eventHash"]); assert(key.category === "answer" && hash(key.eventHash), "invalid-capture-key"); }
    assert(new Set(value.map(key => `${key.category}:${key.eventHash}`)).size === value.length, "duplicate-capture-key");
}
export function validateCaptureHeader(value) {
    object(value, ["schemaVersion", "category", "observationRef", "interactionRef", "dependencies", "consentRevision", "credentialScreenVersion", "captureKeys"]);
    assert(value.schemaVersion === 1 && value.category === "answer" && ref(value.observationRef) && ref(value.interactionRef)
        && Number.isSafeInteger(value.consentRevision) && value.consentRevision > 0 && value.credentialScreenVersion === 1, "invalid-capture-envelope");
    validateDependencies(value.dependencies); validateCaptureKeys(value.captureKeys);
    return value;
}
export function validateCaptureEnvelope(value) {
    object(value, ["schemaVersion", "category", "observationRef", "interactionRef", "dependencies", "consentRevision", "credentialScreenVersion", "captureKeys", "text"]);
    const { text, ...header } = value;
    validateCaptureHeader(header);
    assert(typeof text === "string" && text.length > 0 && Buffer.byteLength(text) <= 65536, "invalid-capture-envelope");
    return value;
}
export function validatePersonalEvaluation(value) {
    object(value, ["schemaVersion", "consent", "source", "overrideRevision", "captures", "feedback", "mutations", "suppressedCaptures",
        ...(value && Object.hasOwn(value, "modelEvaluation") ? ["modelEvaluation"] : [])]);
    assert(value.schemaVersion === 1 && Number.isSafeInteger(value.overrideRevision) && value.overrideRevision >= 0, "invalid-personal-evaluation-version");
    validateConsent(value.consent); validateAssessmentStore(value.feedback);
    if (value.modelEvaluation) validateModelEvaluationState(value.modelEvaluation);
    object(value.source, ["available", "sourceConfigRef", "sourceConfigRevision"]);
    assert(typeof value.source.available === "boolean" && (value.source.sourceConfigRef === null || ref(value.source.sourceConfigRef))
        && Number.isSafeInteger(value.source.sourceConfigRevision) && value.source.sourceConfigRevision >= 0, "invalid-assessment-source");
    assert(Array.isArray(value.captures) && value.captures.length <= 100000, "invalid-capture-index");
    const captures = new Set();
    for (const capture of value.captures) {
        object(capture, ["category", "observation", "dependencies", "payloadFile", "captureKeys"]);
        assert(capture.category === "answer" && /^[a-f0-9]{64}\.json$/.test(capture.payloadFile), "invalid-capture-index");
        validateObservation(capture.observation); validateDependencies(capture.dependencies); validateCaptureKeys(capture.captureKeys);
        assert(capture.observation.kind === capture.category && capture.dependencies.interactionRefs.includes(capture.observation.interactionRef)
            && !captures.has(capture.observation.observationRef), "invalid-capture-index");
        captures.add(capture.observation.observationRef);
    }
    assert(Array.isArray(value.suppressedCaptures) && value.suppressedCaptures.length <= 100000, "invalid-capture-suppression");
    for (const key of value.suppressedCaptures) validateCaptureKeys([key]);
    assert(value.mutations && Object.getPrototypeOf(value.mutations) === Object.prototype && Object.keys(value.mutations).length <= 100000, "invalid-assessment-mutations");
    for (const [mutationRef, mutation] of Object.entries(value.mutations)) {
        object(mutation, ["ownerHash", "inputHash", "dependencies", "receipt", ...(Object.hasOwn(mutation, "receiptTokenHash") ? ["receiptTokenHash"] : [])]);
        if (mutation.receiptTokenHash !== undefined) assert(hash(mutation.receiptTokenHash), "invalid-receipt-token-hash");
        assert(ref(mutationRef) && hash(mutation.ownerHash) && hash(mutation.inputHash)
            && mutation.receipt?.schemaVersion === 1 && mutation.receipt.mutationRef === mutationRef
            && ["complete", "pending", "purged"].includes(mutation.receipt.phase), "invalid-assessment-receipt");
        if (mutation.dependencies !== null) validateDependencies(mutation.dependencies);
        if (mutation.receipt.phase === "purged") {
            object(mutation.receipt, ["schemaVersion", "mutationRef", "phase"]);
            assert(mutation.dependencies === null, "purged-receipt-has-content");
        } else if (mutation.receipt.data?.evaluation) {
            object(mutation.receipt.data, ["evaluation"]);
            object(mutation.receipt.data.evaluation, ["runRef"]);
            assert(ref(mutation.receipt.data.evaluation.runRef), "invalid-evaluation-receipt");
        } else {
            object(mutation.receipt, ["schemaVersion", "mutationRef", "phase", "basis", "data", ...(Object.hasOwn(mutation.receipt, "operationId") ? ["operationId"] : [])]);
            validateBasis(mutation.receipt.basis);
            if (mutation.receipt.operationId !== undefined) assert(/^[a-f0-9-]{36}$/.test(mutation.receipt.operationId), "invalid-assessment-operation");
            if (mutation.receipt.data?.assessment) {
                object(mutation.receipt.data, ["assessment"]);
                validateAssessment(mutation.receipt.data.assessment);
                assert(mutation.receipt.data.assessment.origin === "user-personal", "invalid-feedback-receipt");
            } else {
                object(mutation.receipt.data, ["consent"]);
                validateConsent(mutation.receipt.data.consent);
            }
        }
    }
    return value;
}
export function selectPersonalEvaluationCleanup(personalEvaluation, {
    removedIdentities = [], removedEvents = [], removedContextCalls = [], remainingRecords = [], removedCapturePayloads = [], revokedConsentRevision = null,
    allCollectedActivity = false,
} = {}) {
    const current = personalEvaluation ? validatePersonalEvaluation(personalEvaluation) : defaultPersonalEvaluation();
    assert(typeof allCollectedActivity === "boolean" && (revokedConsentRevision === null || Number.isSafeInteger(revokedConsentRevision) && revokedConsentRevision >= 0), "invalid-cleanup-scope");
    const next = structuredClone(current);
    const removed = new Set([...removedIdentities, ...removedEvents, ...removedContextCalls]);
    const affected = new Set(), payloadFiles = new Set(), suppressed = new Map(current.suppressedCaptures.map(key => [`${key.category}:${key.eventHash}`, key]));
    const removedEvidenceRefs = new Set(), feedbackTargets = new Set();
    const sourceAffected = dependencies => allCollectedActivity || dependencies.deletionKeys.some(key => removed.has(key));
    const feedbackKey = assessment => `${assessment.interactionRef}:${assessment.checkId}`;
    function removeCapture(capture, payloadFile) {
        for (const key of capture.captureKeys) suppressed.set(`${key.category}:${key.eventHash}`, key);
        for (const ref of capture.dependencies.interactionRefs) affected.add(ref);
        for (const ref of capture.dependencies.evidenceRefs) removedEvidenceRefs.add(ref);
        if (payloadFile) {
            assert(typeof payloadFile === "string" && /^[a-f0-9]{64}\.json$/.test(payloadFile), "invalid-capture-file");
            payloadFiles.add(payloadFile);
        }
    }
    next.captures = current.captures.filter(capture => {
        if (!sourceAffected(capture.dependencies) && !capture.captureKeys.some(key => removed.has(key.eventHash))
            && !(revokedConsentRevision !== null && capture.observation.captureContext?.consentRevision <= revokedConsentRevision)) return true;
        removeCapture(capture, capture.payloadFile); return false;
    });
    const removedCaptureRefs = new Set();
    for (const descriptor of removedCapturePayloads) {
        const envelope = descriptor.envelope ?? descriptor;
        if (Object.hasOwn(envelope, "text")) validateCaptureEnvelope(envelope);
        else {
            validateCaptureHeader(envelope);
            assert(Number.isSafeInteger(descriptor.payloadBytes) && descriptor.payloadBytes > 0, "invalid-capture-payload-size");
        }
        removeCapture(envelope, descriptor.payloadFile ?? null);
        removedCaptureRefs.add(envelope.observationRef);
    }
    next.captures = next.captures.filter(capture => !removedCaptureRefs.has(capture.observation.observationRef));
    for (const entry of current.feedback.records) if (sourceAffected(entry.dependencies)
        || entry.dependencies.evidenceRefs.some(ref => removedEvidenceRefs.has(ref))) {
        affected.add(entry.assessment.interactionRef);
        feedbackTargets.add(feedbackKey(entry.assessment));
    }
    next.feedback.records = current.feedback.records.filter(entry => !feedbackTargets.has(feedbackKey(entry.assessment)));
    if (next.modelEvaluation) {
        const removedModelInteractions = new Set();
        for (const run of next.modelEvaluation.runs) {
            const removedScope = run.scope.filter(item => sourceAffected(item.dependencies));
            if (removedScope.length || allCollectedActivity) {
                for (const item of removedScope) removedModelInteractions.add(item.interactionRef);
                run.costUnknown ||= run.phase === "running";
                run.phase = "purged"; run.error = "source-changed";
                run.scope = allCollectedActivity ? [] : run.scope.filter(item => !sourceAffected(item.dependencies));
            }
        }
        next.modelEvaluation.records = next.modelEvaluation.records.filter(record => {
            if (!sourceAffected(record.dependencies) && !record.dependencies.evidenceRefs.some(ref => removedEvidenceRefs.has(ref))) return true;
            removedModelInteractions.add(record.interactionRef); affected.add(record.interactionRef); return false;
        });
        for (const grant of next.modelEvaluation.grants) {
            grant.interactionRefs = allCollectedActivity ? [] : grant.interactionRefs.filter(ref => !removedModelInteractions.has(ref));
            if (!grant.interactionRefs.length) grant.state = "revoked";
        }
        for (const run of next.modelEvaluation.runs) if (allCollectedActivity
            || run.results.some(result => removedModelInteractions.has(result.interactionRef))) {
            run.phase = "purged"; run.error = "source-changed";
            run.results = allCollectedActivity ? [] : run.results.filter(result => !removedModelInteractions.has(result.interactionRef));
        }
        if (removedModelInteractions.size || allCollectedActivity) next.modelEvaluation.revision++;
    }
    for (const [mutationRef, mutation] of Object.entries(next.mutations)) if (mutation.dependencies
        && (sourceAffected(mutation.dependencies) || mutation.dependencies.evidenceRefs.some(ref => removedEvidenceRefs.has(ref))
            || mutation.receipt.data?.assessment && feedbackTargets.has(feedbackKey(mutation.receipt.data.assessment)))) {
        mutation.dependencies = null;
        mutation.receipt = { schemaVersion: 1, mutationRef, phase: "purged" };
    }
    next.suppressedCaptures = [...suppressed.values()];
    if (affected.size) { next.overrideRevision++; next.feedback.revision++; }
    validatePersonalEvaluation(next);
    return {
        next, affectedInteractionRefs: [...affected], payloadFiles: [...payloadFiles],
        counts: { interactions: affected.size, capturedItems: current.captures.length - next.captures.length,
            feedbackRevisions: current.feedback.records.length - next.feedback.records.length },
    };
}
