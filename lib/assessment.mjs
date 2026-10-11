import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { BoardError, exclusiveBoard, loadBoardState, resolveDataDir } from "./store.mjs";
import { ContractError, REQUESTS, validateRequest, validateConsent, validateStoredAssessment, BASIS_KEYS, CAPTURE_LIMITS } from "./assessment-contract.mjs";
import { defaultPersonalEvaluation, validatePersonalEvaluation, validateCaptureEnvelope } from "./personal-evaluation.mjs";
import { safeDeletionFile, DELETION_LIMITS } from "./deletion-storage.mjs";
import {
    assessmentHash, assessmentRef, assessmentBasis, assessmentSource, cachedAssessmentModel,
    assessmentOverview, assessmentDependencies, invalidateAssessmentCache,
} from "./assessment-read-model.mjs";

export function assessmentError(error) {
    if (!(error instanceof ContractError)) return error;
    const status = /pending/.test(error.code) ? 503 : /stale|deleted/.test(error.code) ? 409 : 422;
    const result = new BoardError(`Assessment unavailable (${error.code}). Refresh the current interaction before continuing.`, status);
    result.code = error.code;
    return result;
}
export function assessmentStatus(state) {
    const pending = state.deletion?.pending;
    return { basis: assessmentBasis(state), pendingCleanup: Boolean(pending), operationId: pending ?? null,
        kind: pending ? state.deletion.operations?.[pending]?.kind ?? "activity" : null };
}
function ready(state) {
    if (state.deletion?.pending) throw new ContractError("deletion-pending");
}
const ownerHash = owner => assessmentHash(["assessment-owner", owner]);
function sourceFor(state, options) { return options.source?.(state) ?? state.personalEvaluation?.source ?? assessmentSource(state); }
function envelope(state, data) { return { schemaVersion: 1, basis: assessmentBasis(state), data }; }
function guardBasis(expected, current) {
    for (const key of BASIS_KEYS) if (expected[key] !== current[key]) throw new ContractError(`stale-${key}`);
}
export async function readRetainedResponse(session, state, view, observationRef) {
    const interactionRef = view.interaction.interactionRef;
    const capture = state.personalEvaluation?.captures.find(item => item.observation.observationRef === observationRef && item.observation.interactionRef === interactionRef);
    if (!capture || !view.observations.some(o => o.observationRef === observationRef) || view.consent.state !== "enabled") {
        throw new BoardError("Response evidence is unavailable or no longer authorized.", 403);
    }
    const file = await safeDeletionFile(resolveDataDir(session), path.join("assessment-evidence", capture.payloadFile));
    let bytes;
    try { bytes = await readFile(file); }
    catch (error) {
        if (error.code !== "ENOENT") throw error;
        throw new BoardError("Retained response evidence is no longer available.", 404);
    }
    if (`${assessmentHash(bytes)}.json` !== capture.payloadFile) throw new ContractError("capture-integrity-failed");
    const payload = validateCaptureEnvelope(JSON.parse(bytes));
    if (payload.observationRef !== observationRef || payload.interactionRef !== interactionRef
        || payload.consentRevision !== view.consent.revision || Buffer.byteLength(payload.text) !== capture.observation.payload.utf8Bytes
        || JSON.stringify(payload.dependencies) !== JSON.stringify(capture.dependencies)) throw new ContractError("capture-membership-mismatch");
    return { observationRef, text: payload.text, completeness: capture.observation.payload.completeness, finality: "unverified" };
}
export async function executeAssessmentAction(session, owner, action, input, options = {}) {
    const readOnly = options.readOnly === true;
    try {
        validateRequest(action, input);
        if (readOnly && REQUESTS[action].mutation) throw new BoardError("Read-only assessment access cannot change retained state.", 403);
        if (action === "get_mutation_status") return exclusiveBoard(session, state => {
            const mutation = state.personalEvaluation?.mutations?.[input.mutationRef];
            if (!mutation) return { schemaVersion: 1, mutationRef: input.mutationRef, phase: "not-started" };
            const recovered = input.receiptToken && mutation.receiptTokenHash === assessmentHash(["assessment-receipt", input.receiptToken]);
            if (mutation.ownerHash !== ownerHash(owner) && !recovered) throw new BoardError("This assessment operation requires its original panel or receipt capability.", 403);
            return structuredClone(mutation.receipt);
        }, { readOnly });
        if (REQUESTS[action].mutation) return await exclusiveBoard(session, async (state, save) => {
            ready(state);
            const personal = state.personalEvaluation ? validatePersonalEvaluation(state.personalEvaluation) : defaultPersonalEvaluation();
            const digest = assessmentHash([action, input]), identity = ownerHash(owner), prior = personal.mutations[input.mutationRef];
            if (prior) {
                if (prior.ownerHash !== identity) throw new BoardError("This assessment operation belongs to another panel.", 403);
                if (prior.inputHash !== digest) throw new BoardError("This operation identity already has another payload. Nothing changed.", 409);
                return structuredClone(prior.receipt);
            }
            const source = sourceFor(state, options), currentBasis = assessmentBasis(state);
            let data, dependencies = null, revokedConsentRevision = null;
            state.personalEvaluation = structuredClone(personal);
            state.personalEvaluation.source = source;
            if (action === "set_personal_assessment") {
                guardBasis(input.expectedBasis, currentBasis);
                const model = cachedAssessmentModel(state, source), view = model.details.get(input.interactionRef);
                if (!view) throw new BoardError("Retained interaction no longer exists.", 404);
                const history = personal.feedback.records.filter(entry => entry.assessment.interactionRef === input.interactionRef && entry.assessment.checkId === input.checkId);
                const last = history.at(-1)?.assessment;
                state.personalEvaluation.overrideRevision++;
                state.personalEvaluation.feedback.revision++;
                const nextBasis = assessmentBasis(state);
                const assessment = {
                    schemaVersion: 1, interactionRef: input.interactionRef, basis: nextBasis, createdAt: new Date().toISOString(),
                    evidenceRefs: view.observations.flatMap(o => o.evidenceRefs).filter((ref, index, all) => all.indexOf(ref) === index),
                    assessmentRef: assessmentRef(state, "assessment", [input.mutationRef, input.checkId]), checkId: input.checkId, checkVersion: 1,
                    dimension: { "semantic-answer-correctness": "accuracy", "answer-support-validity": "answer-trust", "action-authorization-compliance": "action-trust" }[input.checkId],
                    unitRef: input.interactionRef, origin: "user-personal", rubricVersion: 1, verdict: input.verdict,
                    reason: input.withdraw ? "user-withdrawn" : "user-verdict", revision: (last?.revision ?? 0) + 1, supersedes: last?.assessmentRef ?? null, withdrawn: input.withdraw,
                };
                dependencies = { ...assessmentDependencies(view), basis: nextBasis };
                const record = { schemaVersion: 1, assessment, dependencies };
                validateStoredAssessment(record);
                state.personalEvaluation.feedback.records.push(record);
                data = { assessment };
            } else {
                if (input.expectedSourceRevision !== currentBasis.sourceRevision || input.expectedConsentRevision !== personal.consent.revision) throw new ContractError("stale-consent");
                if (input.enabled && (!source.available || input.sourceConfigRef !== source.sourceConfigRef || input.sourceConfigRevision !== source.sourceConfigRevision)) throw new ContractError("stale-source");
                const at = new Date().toISOString();
                const consent = {
                    schemaVersion: 1, policyVersion: 1, revision: personal.consent.revision + 1,
                    state: input.enabled ? "enabled" : personal.consent.grantedAt ? "revoked" : "off",
                    categories: input.categories, sourceConfigRef: source.sourceConfigRef ?? input.sourceConfigRef, sourceConfigRevision: source.sourceConfigRevision,
                    grantedAt: input.enabled ? at : personal.consent.grantedAt, revokedAt: !input.enabled && personal.consent.grantedAt ? at : null,
                    grantOrigin: input.enabled || personal.consent.grantedAt ? "explicit-in-app-setup" : null, limits: { ...CAPTURE_LIMITS },
                };
                validateConsent(consent);
                if (personal.consent.state === "enabled") revokedConsentRevision = personal.consent.revision;
                state.personalEvaluation.consent = consent;
                data = { consent };
            }
            const receipt = { schemaVersion: 1, mutationRef: input.mutationRef, phase: "complete",
                basis: assessmentBasis(state), data };
            state.personalEvaluation.mutations[input.mutationRef] = {
                ownerHash: identity, inputHash: digest, dependencies, receipt,
                ...(input.receiptToken ? { receiptTokenHash: assessmentHash(["assessment-receipt", input.receiptToken]) } : {}),
            };
            validatePersonalEvaluation(state.personalEvaluation);
            if (Buffer.byteLength(JSON.stringify(state)) > DELETION_LIMITS.fileBytes) throw new BoardError("Assessment metadata exceeds the safe managed-state limit. Nothing changed.", 413);
            if (revokedConsentRevision !== null) {
                if (!options.commitCaptureRevocation) throw new BoardError("Capture revocation cleanup is not attached. Nothing changed.", 503);
                receipt.phase = "pending";
                receipt.operationId = randomUUID();
                await options.commitCaptureRevocation(state, save, { owner, operationId: receipt.operationId, revokedConsentRevision });
            } else {
                state.revision++;
                await save(state);
            }
            invalidateAssessmentCache();
            options.invalidateDerived?.();
            return structuredClone(state.personalEvaluation.mutations[input.mutationRef].receipt);
        });
        const state = await loadBoardState(session, { readOnly }), source = sourceFor(state, options), model = cachedAssessmentModel(state, source);
        if (action === "get_assessment_consent") return envelope(state, { consent: model.consent, source, capabilities: model.capabilities });
        if (input.expectedSourceRevision !== undefined && input.expectedSourceRevision !== model.basis.sourceRevision) throw new ContractError("stale-sourceRevision");
        if (action === "get_assessment_overview") return envelope(state, assessmentOverview(state, model, input.interactionRefs));
        const view = model.details.get(input.interactionRef);
        if (!view) throw new BoardError("Retained interaction no longer exists.", 404);
        if (action === "get_interaction") return envelope(state, view);
        guardBasis(input.expectedBasis, model.basis);
        const response = await readRetainedResponse(session, state, view, input.observationRef);
        const current = await loadBoardState(session, { readOnly });
        guardBasis(input.expectedBasis, assessmentBasis(current));
        return envelope(current, { ...response, basis: assessmentBasis(current) });
    } catch (error) { throw assessmentError(error); }
}
