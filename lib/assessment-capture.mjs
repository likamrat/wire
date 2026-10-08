import { mkdir, readFile, open, unlink } from "node:fs/promises";
import path from "node:path";
import { exclusiveBoard, resolveDataDir } from "./store.mjs";
import { safeDeletionFile, DELETION_LIMITS } from "./deletion-storage.mjs";
import { eventIdentity } from "./deletion-identities.mjs";
import { textFindings } from "./privacy.mjs";
import { captureDecision, validateObservationForInteraction, ContractError } from "./assessment-contract.mjs";
import { validatePersonalEvaluation, validateCaptureEnvelope } from "./personal-evaluation.mjs";
import { assessmentHash, assessmentRef, assessmentBasis, assessmentDependencies, buildAssessmentModel, invalidateAssessmentCache, recordedInstant } from "./assessment-read-model.mjs";

async function writeCaptureFile(file, content, expectedHash) {
    let handle;
    try { handle = await open(file, "wx", 0o600); }
    catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (assessmentHash(await readFile(file)) !== expectedHash) throw new ContractError("capture-integrity-failed");
        return;
    }
    try {
        try { await handle.writeFile(content); await handle.sync(); }
        finally { await handle.close(); }
    } catch (error) {
        try { await unlink(file); }
        catch (cleanup) { if (cleanup.code !== "ENOENT") throw new AggregateError([error, cleanup], "Capture write and incomplete-file cleanup failed."); }
        throw error;
    }
}

export function collectRecordedAnswerCandidates(events, incomingIds, sourceSessionId) {
    let messageEventId = null;
    const candidates = [];
    for (const event of events) {
        if (event.type === "user.message") messageEventId = typeof event.id === "string" && event.id ? event.id : null;
        if (event.type !== "assistant.message" || typeof event.id !== "string" || !event.id
            || !incomingIds.has(event.id) || typeof event.data?.content !== "string") continue;
        const at = recordedInstant(event.timestamp);
        if (!at) continue;
        candidates.push({ sourceSessionId, sourceEventId: event.id, messageEventId, at, text: event.data.content });
    }
    return candidates;
}
export async function commitRecordedAnswers(session, candidates, expected) {
    if (!candidates.length) return { captured: 0, excluded: 0, suppressed: 0, unassociated: 0 };
    return exclusiveBoard(session, async (state, save) => {
        if (state.deletion?.pending) throw new ContractError("deletion-pending");
        const personal = state.personalEvaluation;
        const counts = { captured: 0, excluded: 0, suppressed: 0, unassociated: 0 };
        if (!personal || personal.consent.state !== "enabled" || personal.consent.revision !== expected.consentRevision) throw new ContractError("stale-consent");
        validatePersonalEvaluation(personal);
        if (personal.source.sourceConfigRef !== expected.source.sourceConfigRef || personal.source.sourceConfigRevision !== expected.source.sourceConfigRevision) throw new ContractError("stale-source");
        const model = buildAssessmentModel(state, { source: expected.source });
        const suppressed = new Set(personal.suppressedCaptures.map(key => `${key.category}:${key.eventHash}`));
        const existing = new Set(personal.captures.map(capture => capture.observation.observationRef));
        const sourceRevision = (state.evidenceRevision ?? state.revision) + 1;
        const nextBasis = { ...assessmentBasis(state), sourceRevision, membershipRevision: sourceRevision };
        for (const candidate of candidates) {
            const eventHash = eventIdentity(candidate.sourceSessionId, candidate.sourceEventId);
            if (suppressed.has(`answer:${eventHash}`)) { counts.suppressed++; continue; }
            const matches = [...model.internals].filter(([, item]) => item.record.sourceSessionId === candidate.sourceSessionId
                && candidate.messageEventId && item.record.userPrompt?.sourceEventId === candidate.messageEventId);
            if (matches.length !== 1) { counts.unassociated++; continue; }
            const interactionRef = matches[0][0], view = model.details.get(interactionRef);
            const observationRef = assessmentRef(state, "observation", [candidate.sourceSessionId, candidate.sourceEventId, "answer", personal.consent.revision]);
            if (existing.has(observationRef)) continue;
            const credentials = textFindings(candidate.text).some(finding => finding.mandatory);
            if (credentials || !candidate.text.trim()) { counts.excluded++; continue; }
            const bytes = Buffer.from(candidate.text, "utf8"), limit = personal.consent.limits.bytesPerItem;
            let end = Math.min(bytes.length, limit);
            while (end < bytes.length && end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
            const text = bytes.length > limit ? bytes.subarray(0, end).toString("utf8") : candidate.text;
            const prior = personal.captures.filter(c => c.observation.interactionRef === interactionRef);
            const decision = captureDecision(personal.consent, {
                category: "answer", adapter: "copilot-local-events-v1", expectedConsentRevision: expected.consentRevision,
                sourceConfigRef: expected.source.sourceConfigRef, sourceConfigRevision: expected.source.sourceConfigRevision,
                sourceApproved: true, alreadyRecorded: true, credentialScreen: "passed", utf8Bytes: Buffer.byteLength(text),
                retainedItemCount: prior.length, retainedTotalBytes: prior.reduce((sum, c) => sum + c.observation.payload.utf8Bytes, 0),
            });
            if (!decision.allowed) { counts.excluded++; continue; }
            const evidenceRef = assessmentRef(state, "evidence", observationRef);
            const observation = {
                schemaVersion: 1, interactionRef, basis: nextBasis, createdAt: new Date().toISOString(), evidenceRefs: [evidenceRef],
                observationRef, memberRef: null, adapter: "copilot-local-events-v1", kind: "answer", origin: "optional-capture",
                availability: "available", reason: null, occurredAt: candidate.at,
                sourceEventRefs: [assessmentRef(state, "event", [candidate.sourceSessionId, candidate.sourceEventId])],
                deletionKeys: [...new Set(view.interaction.members.flatMap(m => m.deletionKeys))],
                payload: { textRef: assessmentRef(state, "text", observationRef), utf8Bytes: Buffer.byteLength(text),
                    completeness: bytes.length > limit ? "bounded-fragment" : "full-record", finality: "unverified", credentialScreenVersion: 1, credentialScreen: "passed" },
                captureContext: { consentRevision: personal.consent.revision, sourceConfigRef: expected.source.sourceConfigRef, sourceConfigRevision: expected.source.sourceConfigRevision },
            };
            validateObservationForInteraction(observation, { ...view.interaction, basis: nextBasis }, personal.consent);
            const dependencies = { ...assessmentDependencies(view), basis: nextBasis, evidenceRefs: [evidenceRef] };
            const captureKeys = [{ category: "answer", eventHash }];
            const envelope = { schemaVersion: 1, category: "answer", observationRef, interactionRef, dependencies,
                consentRevision: personal.consent.revision, credentialScreenVersion: 1, captureKeys, text };
            validateCaptureEnvelope(envelope);
            const content = JSON.stringify(envelope), payloadFile = `${assessmentHash(content)}.json`;
            if (Buffer.byteLength(content) > DELETION_LIMITS.fileBytes) { counts.excluded++; continue; }
            const capture = { category: "answer", observation, dependencies, payloadFile, captureKeys };
            personal.captures.push(capture);
            if (Buffer.byteLength(JSON.stringify(state)) > DELETION_LIMITS.fileBytes) {
                personal.captures.pop(); counts.excluded++; continue;
            }
            const directory = await safeDeletionFile(resolveDataDir(session), "assessment-evidence");
            await mkdir(directory, { recursive: true });
            const file = await safeDeletionFile(resolveDataDir(session), path.join("assessment-evidence", payloadFile));
            await writeCaptureFile(file, content, payloadFile.slice(0, -5));
            existing.add(observationRef); counts.captured++;
        }
        if (counts.captured) {
            state.evidenceRevision = sourceRevision;
            state.revision++;
            validatePersonalEvaluation(personal);
            await save(state);
            invalidateAssessmentCache();
        }
        return counts;
    });
}
