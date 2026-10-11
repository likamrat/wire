import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { privateFixture } from "./helpers.mjs";
import { retainedContextFixture } from "./request-context-fixture.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { assessmentSource, assessmentDependencies, assessmentRef, buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { defaultPersonalEvaluation } from "../lib/personal-evaluation.mjs";
import { collectRecordedAnswerCandidates, commitRecordedAnswers } from "../lib/assessment-capture.mjs";

export async function reportContextFixture(t) {
    const source = retainedContextFixture();
    const records = source.records.slice(0, 2);
    for (const record of records) for (const call of record.toolCalls) {
        call.requestArgs = { entityUrls: ["/me/drive/root/children"] };
    }
    records[0].userPrompt.text += " Contact first@example.invalid.";
    records[1].followUpPrompts = [];
    source.events.find(event => event.id === "reply-three").data.content =
        "Here are three synthetic documents: Research, Architecture, Design.\nContact reply@example.invalid at https://tenant.example.invalid/docs.";
    const unrelated = structuredClone(records[1]);
    unrelated.scenarioId = "unrelated-context";
    unrelated.sourceSessionId = "other-context-chat";
    unrelated.userPrompt.sourceEventId = "unrelated-prompt";
    unrelated.userPrompt.text = "UNRELATED_CONTEXT_MUST_NOT_APPEAR";
    unrelated.toolCalls[0].toolCallId = "unrelated-call";
    unrelated.toolCalls[0].startEventId = "unrelated-start";
    const app = await privateFixture(t, [...records, unrelated]);
    const config = { schemaVersion: 1, approved: true, enabled: false, windowDays: 30, pollSeconds: 5,
        sourceAdapter: "copilot-app-sqlite-v156", appDbPath: path.join(app.context.dataDir, "invented-only.db"),
        sessionRoot: path.join(app.context.dataDir, "invented-only-events") };
    await mkdir(path.join(app.context.dataDir, "collector"), { recursive: true });
    await writeFile(path.join(app.context.dataDir, "collector", "config.json"), JSON.stringify(config));
    const sourceConfig = assessmentSource(await loadBoardState(app.context), config);
    await updateBoardState(app.context, state => {
        const personal = defaultPersonalEvaluation();
        personal.source = sourceConfig;
        personal.consent = { ...personal.consent, state: "enabled", revision: 1, categories: ["answer"],
            sourceConfigRef: sourceConfig.sourceConfigRef, sourceConfigRevision: sourceConfig.sourceConfigRevision,
            grantedAt: "2026-09-30T11:00:00.000Z", grantOrigin: "explicit-in-app-setup" };
        state.personalEvaluation = personal;
    });
    const candidates = collectRecordedAnswerCandidates(source.events, new Set(["reply-three"]), records[0].sourceSessionId);
    assert.equal((await commitRecordedAnswers(app.context, candidates, { consentRevision: 1, source: sourceConfig })).captured, 1);
    await updateBoardState(app.context, state => {
        const model = buildAssessmentModel(state);
        const view = model.details.get(model.catalog.find(item => item.scenarioId === records[0].scenarioId).interactionRef);
        state.personalEvaluation.feedback.records.push({ schemaVersion: 1, dependencies: assessmentDependencies(view), assessment: {
            schemaVersion: 1, interactionRef: view.interaction.interactionRef, basis: view.basis,
            createdAt: "2026-09-30T12:00:03.000Z", evidenceRefs: view.observations.flatMap(item => item.evidenceRefs),
            assessmentRef: assessmentRef(state, "assessment", "invented-five-document-verdict"),
            checkId: "semantic-answer-correctness", checkVersion: 1, dimension: "accuracy", unitRef: view.interaction.interactionRef,
            origin: "user-personal", rubricVersion: 1, verdict: "fail", reason: "user-verdict",
            revision: 1, supersedes: null, withdrawn: false,
        } });
        state.personalEvaluation.feedback.revision = 1;
        state.personalEvaluation.overrideRevision = 1;
    });
    return { ...app, records, sourceConfig };
}
