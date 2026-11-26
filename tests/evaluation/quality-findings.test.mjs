import test from "node:test";
import assert from "node:assert/strict";
import { createAssessmentPresentation } from "../../web/assessment-presentation.mjs";
import { buildReportFacts } from "../../lib/assessment-read-model.mjs";
import { freezeEvaluationFacts } from "../../lib/report-facts.mjs";
import { contract, quality } from "./assessment-ui-fixtures.mjs";
import { matrixRecords } from "../reports/report-evidence-matrix-fixtures.mjs";

const presentation = createAssessmentPresentation(contract);
const text = findings => JSON.stringify(findings);

test("historical status rows bind only to their saved population and cannot be promoted into current report facts", () => {
    const records = matrixRecords("saved-reasons", ["failure", "success"], { groups: 2 });
    const state = { revision: 1, pseudonymKey: "a".repeat(64), evidence: records };
    const current = buildReportFacts(records, state).facts;
    assert.equal(current.metricProjectionVersion, 4);
    assert.equal(Object.hasOwn(current, "reviewStatuses"), false);
    const first = current.recordedOutcomes.find(row => row.kind === "tool-call" && row.outcome === "failure");
    const member = current.memberships.find(row => row.members.some(unit => unit.ref === first.memberRef));
    const status = { interactionRef: member.interactionRef, reviewStatus: { schemaVersion: 1,
        execution: { calls: 1, succeeded: 0, failed: 1, other: 0, causes: [{ cause: "access-denial", count: 1 }] },
        assessment: { result: "none", unavailableReason: null, latestAttempt: "none", inAutomaticScope: false, personalFeedback: false },
    } };
    const archive = { ...current, metricProjectionVersion: 2, reviewStatuses: [status] };
    const before = structuredClone(archive);
    assert.deepEqual(freezeEvaluationFacts(archive).reviewStatuses, [status]);
    for (const edit of [
        facts => { facts.metricProjectionVersion = 4; },
        facts => facts.reviewStatuses.push(structuredClone(status)),
        facts => { facts.reviewStatuses[0].interactionRef = current.memberships.find(row => row !== member).interactionRef; },
        facts => { facts.reviewStatuses[0].reviewStatus.execution.causes[0].count++; },
        facts => { facts.reviewStatuses[0].reviewStatus.execution.privateText = "unexpected"; },
    ]) {
        const altered = structuredClone(archive); edit(altered);
        assert.throws(() => freezeEvaluationFacts(altered));
    }
    assert.deepEqual(archive, before);
});

test("opposed origins and rubrics retain independent findings and deduplicated coverage", () => {
    const personal = quality("accuracy", { personal: true, fail: 1, unassessed: 2 });
    const model = structuredClone(personal);
    model.origin = "model-assessed"; model.checkId = "request-requirements-corroborated";
    model.counts = { pass: 1, fail: 0, unassessed: 2, evaluatorError: 0 }; model.numerator = 1; model.value = 1;
    model.evaluator = { provider: "github-copilot", model: "invented", rubricId: "wire-recorded-interaction-review", rubricVersion: 1 };
    const otherRubric = structuredClone(model);
    otherRubric.evaluator.rubricVersion = 2;
    const metrics = [personal, model, otherRubric], before = structuredClone(metrics);
    const summary = presentation.summarize(metrics);
    assert.equal(summary.evidence.quality.accuracy.assessed, 1);
    assert.equal(summary.evidence.quality.accuracy.rows.length, 3);
    assert.match(text(summary.findings), /Your feedback \/ Answer: Not correct \(1 request\)/);
    assert.match(text(summary.findings), /Saved AI review \/ Answer: Correct \(1 request\)/);
    assert.deepEqual(summary.evidence.quality.accuracy.rows.map(row => row.passShare.value), [0, 1, 1]);
    assert.deepEqual(metrics, before);
});
