import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { updateBoardState, loadBoardState } from "../lib/store.mjs";
import { defaultPersonalEvaluation, validateCaptureEnvelope } from "../lib/personal-evaluation.mjs";
import { assessmentHash, assessmentRef, assessmentBasis, assessmentDependencies, buildAssessmentModel, invalidateAssessmentCache } from "../lib/assessment-read-model.mjs";
import { executeAssessmentAction } from "../lib/assessment.mjs";
import { validateObservationForInteraction } from "../lib/assessment-contract.mjs";

export const inventedSource = () => ({ available: true, sourceConfigRef: `sourceconfig-${"1".repeat(32)}`, sourceConfigRevision: 1 });

// Seed an already-retained invented envelope; no collector, original history reader or capture is run.
export async function seedRetainedReply(session, source = inventedSource(), text = "INVENTED_RETAINED_REPLY three documents found") {
    await updateBoardState(session, state => {
        state.personalEvaluation = defaultPersonalEvaluation();
        state.personalEvaluation.source = source;
    });
    let state = await loadBoardState(session);
    await executeAssessmentAction(session, "corpus-fixture", "set_assessment_consent", {
        schemaVersion: 1, mutationRef: `mutation-${randomUUID().replaceAll("-", "")}`,
        expectedSourceRevision: state.evidenceRevision, expectedConsentRevision: 0,
        policyVersion: 1, enabled: true, categories: ["answer"],
        sourceConfigRef: source.sourceConfigRef, sourceConfigRevision: source.sourceConfigRevision, confirmed: true,
    }, { source: () => source });
    state = await loadBoardState(session);
    const model = buildAssessmentModel(state, { source }), view = [...model.details.values()][0];
    const interactionRef = view.interaction.interactionRef;
    const observationRef = assessmentRef(state, "observation", "invented-response");
    const evidenceRef = assessmentRef(state, "evidence", observationRef), basis = assessmentBasis(state);
    const dependencies = { ...assessmentDependencies(view), basis, evidenceRefs: [evidenceRef] };
    const captureKeys = [{ category: "answer", eventHash: assessmentHash("invented-event") }];
    const observation = {
        schemaVersion: 1, interactionRef, basis, createdAt: "2026-10-01T12:00:00.000Z", evidenceRefs: [evidenceRef],
        observationRef, memberRef: null, adapter: "copilot-local-events-v1", kind: "answer", origin: "optional-capture",
        availability: "available", reason: null, occurredAt: "2026-10-01T12:00:00.000Z",
        sourceEventRefs: [assessmentRef(state, "event", "invented-event")],
        deletionKeys: [...new Set(view.interaction.members.flatMap(member => member.deletionKeys))],
        payload: { textRef: assessmentRef(state, "text", observationRef), utf8Bytes: Buffer.byteLength(text),
            completeness: "bounded-fragment", finality: "unverified", credentialScreenVersion: 1, credentialScreen: "passed" },
        captureContext: { consentRevision: 1, sourceConfigRef: source.sourceConfigRef, sourceConfigRevision: source.sourceConfigRevision },
    };
    validateObservationForInteraction(observation, view.interaction, state.personalEvaluation.consent);
    const envelope = { schemaVersion: 1, category: "answer", observationRef, interactionRef, dependencies,
        consentRevision: 1, credentialScreenVersion: 1, captureKeys, text };
    validateCaptureEnvelope(envelope);
    const bytes = JSON.stringify(envelope), payloadFile = `${assessmentHash(bytes)}.json`;
    const directory = path.join(session.dataDir, "assessment-evidence");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, payloadFile), bytes, { mode: 0o600 });
    await updateBoardState(session, current => {
        current.personalEvaluation.captures.push({ category: "answer", observation, dependencies, payloadFile, captureKeys });
    });
    invalidateAssessmentCache();
    return { payloadFile: path.join(directory, payloadFile), observationRef };
}
