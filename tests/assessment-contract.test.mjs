import test from "node:test";
import assert from "node:assert/strict";
import {
    BASIS_KEYS, CURRENT_DIMENSIONS, RULES, ContractError, defaultConsent, validateInteraction, validateObservation,
    validateObservationForInteraction, validateConsent, captureDecision, validateAssessment,
    evaluateCheck, appendPersonalRevision, activeAssessment, validateMetric, poolMetrics,
    assertCurrent, affectedDerivedRefs, validateReportFacts, freezeReportFacts, validateRequest,
    validateStoredAssessment, validateAssessmentStore, validateInteractionView, metricSlotKey,
} from "../lib/assessment-contract.mjs";
import {
    at, id, key, basis, makeMember, makeInteraction, makeObservation, enabledConsent, captureRequest,
    makeAssessment, makeRatio, makeDuration, makeCost, metricBase, makeDependencies, makeCurrent, makeSnapshot,
} from "./assessment-contract-fixtures.mjs";

const rejects = (fn, code) => assert.throws(fn, error => error instanceof ContractError && (!code || error.code === code));

test("current assessment-derived dimensions expose only recorded timing", () => {
    assert.deepEqual(CURRENT_DIMENSIONS, ["speed"]);
});

test("synthetic: mixed retained interaction preserves five separate evidence units and unverified message origin", () => {
    const interaction = makeInteraction(), before = structuredClone(interaction);
    assert.equal(validateInteraction(interaction), interaction);
    assert.equal(interaction.members.length, 5);
    assert.equal(interaction.message.origin, "recorded-unverified");
    assert.deepEqual(interaction, before);
    interaction.message.origin = "human";
    rejects(() => validateInteraction(interaction), "invalid-enum");
});

test("synthetic: call/start aliases are not returned-entry, owned HTTP, or graph identities", () => {
    const interaction = makeInteraction();
    interaction.members[0].aliases.push({ kind: "start", keyHash: key(99) });
    validateInteraction(interaction);
    interaction.members.push({ ...makeMember("tool-call", 10), aliases: [{ kind: "start", keyHash: key(99) }] });
    rejects(() => validateInteraction(interaction), "duplicate-identity");
});

test("synthetic: duplicate record refs, response indices and missing parents fail closed", () => {
    const duplicate = makeInteraction(); duplicate.members.push(structuredClone(duplicate.members[0]));
    rejects(() => validateInteraction(duplicate), "duplicate-identity");
    const indices = makeInteraction(); indices.members.push(makeMember("returned-api-entry", 12));
    rejects(() => validateInteraction(indices), "duplicate-identity");
    const orphan = makeInteraction(); orphan.members = orphan.members.slice(1);
    rejects(() => validateInteraction(orphan), "orphan-returned-entry");
});

test("synthetic: partial pruned membership survives but cannot advertise completeness", () => {
    const partial = makeInteraction(); partial.pruned = true; partial.members = [partial.members[0]];
    rejects(() => validateInteraction(partial), "overstated-membership");
    partial.membershipStatus = "partial"; validateInteraction(partial);
    partial.members = [];
    rejects(() => validateInteraction(partial), "empty-retained-interaction");
});

test("synthetic: conflicted/unidentifiable membership cannot silently become complete", () => {
    for (const key of ["conflicted", "unidentifiable"]) {
        const interaction = makeInteraction(); interaction.excluded[key] = 1;
        rejects(() => validateInteraction(interaction), "overstated-membership");
        interaction.membershipStatus = "unverified"; validateInteraction(interaction);
    }
});

test("synthetic: strict transport versions and unknown fields never fall through", () => {
    const interaction = makeInteraction(); interaction.schemaVersion = 2;
    rejects(() => validateInteraction(interaction), "invalid-literal");
    interaction.schemaVersion = 1; interaction.rawPrompt = "ARTIFICIAL TEXT";
    rejects(() => validateInteraction(interaction), "unexpected-or-missing-field");
    rejects(() => validateInteraction(null), "expected-plain-object");
});

test("synthetic: invalid/unknown source time is null, not a normalized impossible calendar date", () => {
    const interaction = makeInteraction(); interaction.members[0].startedAt = null;
    validateInteraction(interaction);
    interaction.members[0].startedAt = "2026-02-30T12:00:00.000Z";
    rejects(() => validateInteraction(interaction), "invalid-instant");
    interaction.members[0].startedAt = "2026-10-06T12:00:00";
    rejects(() => validateInteraction(interaction), "invalid-instant");
});

test("synthetic: supported metadata binds to the correct retained unit without product imports", () => {
    for (const kind of ["tool-outcome", "returned-status", "http-status", "graph-status", "duration"]) {
        const observation = makeObservation(kind);
        validateObservationForInteraction(observation, makeInteraction(), defaultConsent());
        observation.memberRef = id("record", 999);
        rejects(() => validateObservationForInteraction(observation, makeInteraction(), defaultConsent()), "evidence-unit-mismatch");
    }
});

test("synthetic: response array index is not a target URL and cannot migrate to another entry", () => {
    const observation = makeObservation("returned-status");
    observation.payload.index = 1;
    rejects(() => validateObservationForInteraction(observation, makeInteraction(), defaultConsent()), "response-index-mismatch");
    observation.payload.index = 0; observation.payload.targetUrl = "https://example.invalid";
    rejects(() => validateObservation(observation), "unexpected-or-missing-field");
});

test("synthetic: tool success is execution only; missing, partial and contradictory outcomes stay distinct", () => {
    const observation = makeObservation();
    assert.deepEqual(evaluateCheck("recorded-tool-success", observation), { verdict: "pass", reason: null });
    observation.payload = { completionRecorded: true, toolSucceeded: false, reportedOutcome: "failed" };
    assert.deepEqual(evaluateCheck("recorded-tool-success", observation), { verdict: "fail", reason: null });
    observation.payload.reportedOutcome = "partial";
    assert.equal(evaluateCheck("recorded-tool-success", observation).verdict, "unassessed");
    observation.payload = { completionRecorded: false, toolSucceeded: null, reportedOutcome: "unknown" };
    assert.equal(evaluateCheck("recorded-tool-success", observation).reason, "missing-completion");
    observation.payload.toolSucceeded = true;
    rejects(() => evaluateCheck("recorded-tool-success", observation), "outcome-without-completion");
});

for (const [check, kind] of [["returned-status-2xx", "returned-status"], ["graph-output-status-2xx", "graph-status"], ["owned-http-status-2xx", "http-status"]]) {
    test(`synthetic: ${check} gives only its narrow status verdict`, () => {
        for (const [status, expected] of [[200, "pass"], [204, "pass"], [302, "unassessed"], [100, "unassessed"], [401, "fail"], [599, "fail"]]) {
            const observation = makeObservation(kind); observation.payload.statusCode = status;
            assert.equal(evaluateCheck(check, observation).verdict, expected);
            assert.equal(evaluateCheck("semantic-answer-correctness", observation).verdict, "unassessed");
            assert.equal(evaluateCheck("action-authorization-compliance", observation).verdict, "unassessed");
        }
        const invalid = makeObservation(kind); invalid.payload.statusCode = 600;
        rejects(() => validateObservation(invalid), "invalid-status");
    });
}

test("synthetic: code references cannot acquire HTTP status or request counts", () => {
    const observation = makeObservation("graph-status");
    observation.memberRef = id("record", 5); observation.payload.evidenceLevel = "code-reference";
    rejects(() => validateObservation(observation), "unobserved-graph-status");
    observation.payload.statusCode = null;
    observation.deletionKeys = [key(5)];
    validateObservationForInteraction(observation, makeInteraction(), defaultConsent());
    assert.equal(evaluateCheck("graph-output-status-2xx", observation).verdict, "unassessed");
    observation.payload.requestCount = 1;
    rejects(() => validateObservation(observation), "expected-null");
});

test("synthetic: HTTP header presence/transport failure is not an observed successful response", () => {
    const observation = makeObservation("http-status");
    observation.payload.responseObserved = false;
    rejects(() => validateObservation(observation), "unobserved-http-status");
    observation.payload.statusCode = null; observation.payload.transportError = "TimeoutError";
    assert.equal(evaluateCheck("owned-http-status-2xx", observation).verdict, "unassessed");
    observation.payload.authorizationPresent = true;
    rejects(() => validateObservation(observation), "unexpected-or-missing-field");
});

test("synthetic: duration requires exact nonnegative boundary and never a call total as task latency", () => {
    const observation = makeObservation("duration");
    observation.payload.value = -1;
    rejects(() => validateObservation(observation), "invalid-nonnegative-number");
    observation.payload.value = 2000;
    rejects(() => validateObservation(observation), "inconsistent-duration");
    observation.payload.value = 1000; observation.payload.boundary = "whole-task";
    rejects(() => validateObservation(observation), "invalid-enum");
    const metric = metricBase("interaction-latency");
    validateMetric(metric);
    metric.status = "measured"; metric.value = 1000; metric.reason = null;
    rejects(() => validateMetric(metric));
});

test("synthetic: absent migration config is default-off; contract evaluation performs no activation", () => {
    const consent = defaultConsent(), request = captureRequest();
    validateConsent(consent);
    assert.equal(captureDecision(consent, { ...request, expectedConsentRevision: 0 }).reason, "capture-disabled");
    assert.equal(consent.state, "off"); assert.deepEqual(consent.categories, []);
    const invalid = { ...enabledConsent(), grantOrigin: "development-approval" };
    rejects(() => validateConsent(invalid), "invalid-literal");
});

test("synthetic: enabling answer capture requires the same approved recorded source and explicit setup grant", () => {
    const consent = enabledConsent(), request = captureRequest();
    assert.deepEqual(captureDecision(consent, request), { allowed: true, reason: null });
    for (const change of [{ sourceApproved: false }, { alreadyRecorded: false }, { sourceConfigRef: id("config", 2) }, { sourceConfigRevision: 2 }]) {
        assert.equal(captureDecision(consent, { ...request, ...change }).reason, "stale-source");
    }
    consent.categories = ["usage"];
    assert.equal(captureDecision(consent, request).reason, "category-not-consented");
});

test("synthetic: usage and explicit authorization are unavailable without a demonstrated adapter schema", () => {
    for (const category of ["usage", "explicit-authorization"]) {
        const consent = enabledConsent(), request = { ...captureRequest(), category };
        assert.equal(captureDecision(consent, request).reason, "unsupported-adapter");
        const observation = makeObservation(category);
        validateObservation(observation);
        observation.availability = "available"; observation.reason = null; observation.evidenceRefs = [id("evidence")]; observation.payload = { amount: 0 };
        rejects(() => validateObservation(observation), "unsupported-adapter");
    }
});

test("synthetic: category capture is bounded and credential-screened without retaining answer text in facts", () => {
    const consent = enabledConsent(), request = captureRequest();
    for (const credentialScreen of ["excluded", "not-run"]) assert.equal(captureDecision(consent, { ...request, credentialScreen }).reason, "credential-excluded");
    for (const change of [{ utf8Bytes: 65537 }, { retainedItemCount: 20 }, { retainedTotalBytes: 262140 }]) {
        assert.equal(captureDecision(consent, { ...request, ...change }).reason, "capture-limit");
    }
    const observation = makeObservation("answer");
    observation.payload.text = "ARTIFICIAL ANSWER";
    rejects(() => validateObservation(observation), "unexpected-or-missing-field");
});

test("synthetic: retained answer availability is not final-answer evidence, accuracy or answer-trust", () => {
    const observation = makeObservation("answer"), interaction = makeInteraction();
    interaction.basis.consentRevision = 1;
    validateObservationForInteraction(observation, interaction, enabledConsent());
    assert.equal(evaluateCheck("answer-evidence-present", observation).verdict, "pass");
    assert.equal(RULES["answer-evidence-present"].dimension, "evidence");
    for (const check of ["semantic-answer-correctness", "answer-support-validity", "action-authorization-compliance"]) {
        assert.equal(evaluateCheck(check, observation).reason, "unsupported-check");
    }
    observation.payload.finality = "final";
    rejects(() => validateObservation(observation), "invalid-literal");
});

test("synthetic: revocation and stale source settings reject late extra evidence", () => {
    const consent = enabledConsent(), revoked = { ...consent, state: "revoked", revision: 2, categories: [], revokedAt: at };
    validateConsent(revoked);
    assert.equal(captureDecision(revoked, captureRequest()).reason, "stale-consent");
    const interaction = makeInteraction(); interaction.basis.consentRevision = 1;
    rejects(() => validateObservationForInteraction(makeObservation("answer"), interaction, revoked), "stale-consent");
    interaction.sourceConfigRevision = 2;
    rejects(() => validateObservationForInteraction(makeObservation("answer"), interaction, consent), "stale-source");
});

test("synthetic: unavailable observation is explicit and cannot carry success-shaped payload", () => {
    const observation = makeObservation();
    observation.availability = "unavailable"; observation.reason = "missing-evidence";
    rejects(() => validateObservation(observation), "expected-null");
    observation.payload = null;
    assert.equal(evaluateCheck("recorded-tool-success", observation).verdict, "unassessed");
    observation.reason = null;
    rejects(() => validateObservation(observation), "missing-unavailable-reason");
});

test("synthetic: unsupported automatic accuracy never becomes a score or evaluator failure", () => {
    const assessment = makeAssessment();
    validateAssessment(assessment);
    assessment.verdict = "pass"; assessment.reason = null; assessment.evidenceRefs = [id("evidence")];
    rejects(() => validateAssessment(assessment), "unsupported-semantic-verdict");
    assessment.verdict = "evaluator-error"; assessment.reason = "evaluator-failure";
    rejects(() => validateAssessment(assessment), "unsupported-semantic-verdict");
});

test("synthetic: negative personal verdict, insufficient evidence and evaluator error remain distinct", () => {
    const personal = makeAssessment(true); personal.verdict = "fail"; validateAssessment(personal);
    const failedEvaluator = {
        ...makeAssessment(), checkId: "recorded-tool-success", dimension: "execution", unitRef: id("record"),
        verdict: "evaluator-error", reason: "evaluator-failure",
    };
    validateAssessment(failedEvaluator);
    failedEvaluator.reason = "missing-evidence";
    rejects(() => validateAssessment(failedEvaluator), "invalid-evaluator-error");
});

test("synthetic: personal overrides append without mutating raw facts or prior assessment versions", () => {
    const automatic = makeAssessment(), first = makeAssessment(true), before = JSON.stringify([automatic, first]);
    const history = appendPersonalRevision([], first);
    const second = { ...first, assessmentRef: id("assessment", 3), revision: 2, supersedes: first.assessmentRef, verdict: "fail" };
    const revised = appendPersonalRevision(history, second);
    assert.equal(activeAssessment(automatic, revised).verdict, "fail");
    assert.equal(JSON.stringify([automatic, first]), before);
    assert.equal(history.length, 1);
    rejects(() => appendPersonalRevision(revised, second), "stale-override");
});

test("synthetic: optional withdrawal restores automatic unassessed, never fabricates a pass", () => {
    const first = makeAssessment(true);
    const withdrawn = { ...first, assessmentRef: id("assessment", 3), revision: 2, supersedes: first.assessmentRef, verdict: "unassessed", reason: "user-withdrawn", withdrawn: true };
    assert.equal(activeAssessment(makeAssessment(), [first, withdrawn]).verdict, "unassessed");
    first.basis.sourceRevision++;
    rejects(() => activeAssessment(makeAssessment(), [first]), "stale-sourceRevision");
});

test("synthetic: impossible counts/coverage and display percentages are rejected", () => {
    const metric = makeRatio(2, 1, 1); validateMetric(metric);
    assert.equal(metric.value, 2 / 3); assert.equal(metric.coverage.eligible, 4);
    const tooMany = structuredClone(metric); tooMany.counts.pass++;
    rejects(() => validateMetric(tooMany), "impossible-counts");
    const negative = structuredClone(metric); negative.counts.fail = -1;
    rejects(() => validateMetric(negative), "invalid-count");
    const percent = structuredClone(metric); percent.value *= 100;
    rejects(() => validateMetric(percent), "invalid-ratio");
    const impossibleCoverage = structuredClone(metric); impossibleCoverage.coverage.covered = 5;
    rejects(() => validateMetric(impossibleCoverage), "impossible-coverage");
});

test("synthetic: zero assessed/eligible gives null, not zero success or failure", () => {
    for (const metric of [makeRatio(0, 0, 0), makeRatio(0, 0, 4), makeRatio(0, 0, 1, 2)]) {
        validateMetric(metric); assert.equal(metric.value, null);
        const empty = structuredClone(metric); empty.value = 0;
        rejects(() => validateMetric(empty), "unavailable-has-value");
    }
});

test("synthetic: accuracy and answer/action trust cannot blend or borrow execution counts", () => {
    const metric = makeRatio();
    metric.dimension = "accuracy";
    rejects(() => validateMetric(metric), "check-definition-mismatch");
    metric.dimension = "trust";
    rejects(() => validateMetric(metric), "invalid-enum");
    metric.dimension = "accuracy"; metric.checkId = "semantic-answer-correctness";
    rejects(() => validateMetric(metric), "unsupported-semantic-verdict");
    metric.origin = "user-personal"; validateMetric(metric);
});

test("synthetic: pooled compatible pass share uses counts, never average of displayed percentages", () => {
    const first = makeRatio(1, 0), second = makeRatio(1, 8, 0, 0, 10);
    const pooled = poolMetrics([first, second], id("metric", 99), at);
    assert.equal(pooled.numerator, 2); assert.equal(pooled.denominator, 10); assert.equal(pooled.value, 0.2);
    assert.notEqual(pooled.value, (first.value + second.value) / 2);
});

test("synthetic: overlapping membership and definition/check/units/boundaries cannot be pooled", () => {
    rejects(() => poolMetrics([makeRatio(), makeRatio()], id("metric", 99), at), "duplicate-identity");
    const second = makeRatio(1, 0, 0, 0, 3); second.checkId = "returned-status-2xx";
    rejects(() => poolMetrics([makeRatio(), second], id("metric", 99), at), "incompatible-definitions");
    const badUnit = makeDuration(); badUnit.unit = "USD";
    rejects(() => validateMetric(badUnit), "definition-mismatch");
    const badBoundary = makeDuration(); badBoundary.boundary = "sum-concurrent-calls";
    rejects(() => validateMetric(badBoundary), "definition-mismatch");
});

test("synthetic: duration distribution recomputes raw samples, not sum or median of medians", () => {
    const pooled = poolMetrics([makeDuration([1000]), makeDuration([1, 2, 3, 4, 5], 10)], id("metric", 99), at);
    assert.equal(pooled.value, 3);
    assert.equal(pooled.samples.length, 6);
    assert.equal(pooled.boundary, "tool-start-to-completion");
    assert.notEqual(pooled.value, 1003);
});

test("synthetic: expensive, slow and genuine zero values remain exact when supported", () => {
    const cost = makeCost("measured"); cost.value = 2500.125; validateMetric(cost);
    const duration = makeDuration([3600000]); validateMetric(duration);
    cost.value = 0; validateMetric(cost);
    assert.equal(cost.value, 0); assert.equal(duration.value, 3600000);
    const missing = makeCost(); missing.value = 0;
    rejects(() => validateMetric(missing), "unavailable-has-value");
});

test("synthetic: four cost states cannot silently mix, impute missing usage or omit pricing", () => {
    for (const state of ["measured", "estimated", "unpriced", "not-measured"]) validateMetric(makeCost(state));
    const cost = makeCost("estimated"); cost.value = -0.1;
    rejects(() => validateMetric(cost), "invalid-nonnegative-number");
    cost.value = 0.1; cost.pricing = null;
    rejects(() => validateMetric(cost), "cost-without-attribution");
    rejects(() => poolMetrics([makeCost("measured"), makeCost("estimated")], id("metric", 99), at), "incompatible-definitions");
});

test("synthetic: available source timestamps are exact locally and withheld from report facts by default", () => {
    const metric = makeRatio();
    metric.observedTime = { state: "available", firstAt: at, lastAt: at, datedUnits: 1, undatedUnits: 0 };
    validateMetric(metric);
    const snapshot = makeSnapshot(); snapshot.metrics = [metric];
    rejects(() => validateReportFacts(snapshot), "raw-source-times-not-report-facts");
    metric.observedTime = { ...metric.observedTime, state: "withheld", firstAt: null, lastAt: null };
    validateReportFacts(snapshot);
});

for (const key of BASIS_KEYS) {
    test(`synthetic: ${key} rejects a stale read/write/cache result`, () => {
        const current = makeCurrent(); current.basis[key]++;
        rejects(() => assertCurrent(makeDependencies(), current), `stale-${key}`);
    });
}

test("synthetic: pending deletion blocks derived reads, writes and preview facts until recovery completes", () => {
    const current = makeCurrent(); current.pendingCleanup = true;
    rejects(() => assertCurrent(makeDependencies(), current), "deletion-pending");
    current.pendingCleanup = false; assert.equal(assertCurrent(makeDependencies(), current), true);
});

test("synthetic: removed aliases stop late completion/restart/rotation from reattaching derived facts", () => {
    const current = makeCurrent(); current.removedIdentityHashes = [key(1)];
    rejects(() => assertCurrent(makeDependencies(), current), "deleted-dependency");
    current.removedIdentityHashes = []; current.retainedRecordRefs = [];
    rejects(() => assertCurrent(makeDependencies(), current), "deleted-dependency");
});

test("synthetic: partial deletion invalidates dependent unsaved facts; unrelated facts are not relinked", () => {
    const entries = [
        { ref: id("derived", 1), dependencies: makeDependencies() },
        { ref: id("derived", 2), dependencies: { ...makeDependencies(), recordRefs: [id("record", 2)], deletionKeys: [key(2)] } },
    ];
    assert.deepEqual(affectedDerivedRefs(entries, [key(1)]), [id("derived", 1)]);
    assert.deepEqual(affectedDerivedRefs(entries, [], 0), [id("derived", 1), id("derived", 2)]);
});

test("synthetic: report facts cannot carry answer text, local source names, tombstones or prompt similarity", () => {
    for (const field of ["answer", "sourceSessionId", "deletionKeys", "promptSimilarity"]) {
        const snapshot = makeSnapshot(); snapshot[field] = "ARTIFICIAL TEXT";
        rejects(() => validateReportFacts(snapshot), "unexpected-or-missing-field");
    }
    const snapshot = makeSnapshot(); snapshot.patterns[0].pattern.rawEndpoint = "/private-literal";
    rejects(() => validateReportFacts(snapshot), "unexpected-or-missing-field");
});

test("synthetic: frozen snapshots have exact membership, namespace metadata and stale-fact rejection", () => {
    const snapshot = makeSnapshot(); validateReportFacts(snapshot);
    snapshot.metrics[0].basis.sourceRevision++;
    rejects(() => validateReportFacts(snapshot), "stale-sourceRevision");
    snapshot.metrics[0].basis.sourceRevision--; snapshot.memberships[0].members = [];
    rejects(() => validateReportFacts(snapshot), "outcome-membership-mismatch");
});

test("synthetic: report membership cannot count the same record under duplicate interaction aliases", () => {
    const snapshot = makeSnapshot();
    snapshot.memberships.push({ ...snapshot.memberships[0], interactionRef: id("interaction", 2) });
    rejects(() => validateReportFacts(snapshot), "duplicate-identity");
});

test("synthetic: frozen fact bytes survive later feedback edits; no format serializer is invoked", () => {
    const source = makeSnapshot(), frozen = freezeReportFacts(source), before = JSON.stringify(frozen);
    source.assessments = [makeAssessment(true)]; source.metrics[0].value = 0;
    assert.equal(JSON.stringify(frozen), before);
    assert.equal(frozen.assessments[0].verdict, "unassessed");
    assert.throws(() => { frozen.metrics[0].value = 0; }, TypeError);
});

test("synthetic: exact recorded outcomes preserve partial/unknown/transport independently of assessments", () => {
    const snapshot = makeSnapshot();
    validateReportFacts(snapshot);
    assert.deepEqual(snapshot.recordedOutcomes.map(item => item.outcome), ["partial", "failure", "transport", "unknown"]);
    snapshot.recordedOutcomes.pop();
    rejects(() => validateReportFacts(snapshot), "outcome-membership-mismatch");
});

test("synthetic: code references never enter execution outcomes and status units cannot be swapped", () => {
    const snapshot = makeSnapshot();
    snapshot.recordedOutcomes[0].kind = "graph-code-reference";
    rejects(() => validateReportFacts(snapshot), "code-reference-is-not-execution");
    snapshot.recordedOutcomes[0].kind = "tool-call";
    snapshot.recordedOutcomes[1].outcome = "success";
    rejects(() => validateReportFacts(snapshot), "status-outcome-mismatch");
});

test("synthetic: safe technical display requires a trusted normalizer adapter before facts freeze", () => {
    const snapshot = makeSnapshot(), pattern = snapshot.patterns[0].pattern;
    pattern.targetShape = "single"; pattern.display.attribution = "requested-single-target";
    pattern.display.endpoints = [{ pathTemplate: "/me/messages", method: null, apiVersion: null, queryKeys: ["$top"] }];
    rejects(() => freezeReportFacts(snapshot), "trusted-endpoint-validator-required");
    const options = { validateEndpoint: endpoint => endpoint.pathTemplate === "/me/messages" && endpoint.queryKeys.every(key => key === "$top") };
    freezeReportFacts(snapshot, options);
    pattern.display.endpoints[0].pathTemplate = "/me/private-literal";
    rejects(() => freezeReportFacts(snapshot, options), "unsafe-endpoint-projection");
    pattern.display.tool = "nonallowlisted-private-tool";
    rejects(() => freezeReportFacts(snapshot, options), "invalid-enum");
});

test("synthetic: versioned mutations require exact revisions; caller cannot submit raw facts or set an owner", () => {
    const request = {
        schemaVersion: 1, mutationRef: id("mutation"), expectedSourceRevision: 7, expectedConsentRevision: 0,
        policyVersion: 1, enabled: true, categories: ["answer"], sourceConfigRef: id("config"), sourceConfigRevision: 1, confirmed: true,
    };
    validateRequest("set_assessment_consent", request);
    request.owner = "spoofed";
    rejects(() => validateRequest("set_assessment_consent", request), "unexpected-or-missing-field");
    rejects(() => validateRequest("set_personal_assessment", {}), "unknown-action");
    rejects(() => validateRequest("write_observation", {}), "unknown-action");
});

test("synthetic: consent setup and revocation have explicit category scope, not startup defaults", () => {
    const request = {
        schemaVersion: 1, mutationRef: id("mutation"), expectedSourceRevision: 7, expectedConsentRevision: 0,
        policyVersion: 1, enabled: true, categories: ["answer"], sourceConfigRef: id("config"), sourceConfigRevision: 1, confirmed: true,
    };
    validateRequest("set_assessment_consent", request);
    request.confirmed = false;
    rejects(() => validateRequest("set_assessment_consent", request), "invalid-literal");
    request.confirmed = true; request.enabled = false;
    rejects(() => validateRequest("set_assessment_consent", request), "invalid-consent-categories");
    request.categories = []; validateRequest("set_assessment_consent", request);
});

test("synthetic: stored assessment wrappers preserve traceable versioned dependencies and revision chains", () => {
    const first = { schemaVersion: 1, assessment: makeAssessment(true), dependencies: makeDependencies() };
    validateStoredAssessment(first);
    const second = structuredClone(first);
    second.assessment.assessmentRef = id("assessment", 3); second.assessment.revision = 2;
    second.assessment.supersedes = first.assessment.assessmentRef;
    validateAssessmentStore({ schemaVersion: 1, revision: 2, records: [first, second] });
    rejects(() => validateAssessmentStore({ schemaVersion: 2, revision: 2, records: [first, second] }), "invalid-literal");
    rejects(() => validateAssessmentStore({ schemaVersion: 1, revision: 2, records: [second, first] }), "invalid-history-chain");
    first.dependencies.interactionRefs = [id("interaction", 99)];
    rejects(() => validateStoredAssessment(first), "assessment-dependency-mismatch");
});

test("synthetic: one-click detail contract binds all cached facts to one exact interaction and generation", () => {
    const view = {
        schemaVersion: 1, basis: basis(), interaction: makeInteraction(), consent: defaultConsent(),
        observations: [makeObservation()], assessments: [makeAssessment()], metrics: [makeRatio()],
    };
    validateInteractionView(view);
    view.metrics[0] = makeRatio(1, 0, 0, 0, 99);
    rejects(() => validateInteractionView(view), "metric-outside-interaction");
    view.metrics = []; view.basis.membershipRevision++;
    rejects(() => validateInteractionView(view), "stale-membershipRevision");
});

test("synthetic: snapshot active metrics reject per-interaction duplicate slots rather than last-one-wins", () => {
    const snapshot = makeSnapshot(), next = makeRatio(0, 0, 1, 0, 1);
    snapshot.metrics.push(next);
    rejects(() => validateReportFacts(snapshot), "duplicate-identity");
    assert.notEqual(metricSlotKey(makeCost("measured")), metricSlotKey(makeCost("estimated")));
    assert.notEqual(metricSlotKey(makeCost("unpriced")), metricSlotKey(makeCost("not-measured")));
});

test("synthetic: compatible attributed cost subtotals add once per disjoint usage scope, never per-task averages", () => {
    const first = makeCost("measured"), second = makeCost("measured");
    second.metricRef = id("metric", 2); second.eligibleUnitRefs = [id("record", 2)]; second.coveredUnitRefs = [id("record", 2)];
    rejects(() => poolMetrics([first, second], id("metric", 99), at), "duplicate-identity");
    second.pricing.usageRefs = [id("usage", 2)]; second.evidenceRefs = [id("usage", 2)]; second.value = 1.75;
    const pooled = poolMetrics([first, second], id("metric", 99), at);
    assert.equal(pooled.value, 2); assert.equal(pooled.coverage.covered, 2);
    second.pricing.reference = id("price", 2);
    assert.notEqual(metricSlotKey(first), metricSlotKey(second));
    rejects(() => poolMetrics([first, second], id("metric", 99), at), "incompatible-definitions");
});

test("synthetic: unsupported latency and missing cost pool coverage, not invented measurements", () => {
    for (const definition of ["interaction-latency", "attributed-cost"]) {
        const first = definition === "attributed-cost" ? makeCost() : metricBase(definition);
        const second = structuredClone(first); second.metricRef = id("metric", 2); second.eligibleUnitRefs = [id("record", 2)];
        const pooled = poolMetrics([first, second], id("metric", 99), at);
        assert.equal(pooled.status, "not-measured"); assert.equal(pooled.value, null);
        assert.deepEqual(pooled.coverage, { covered: 0, eligible: 2 });
    }
});

test("synthetic: returned API evidence inherits call deletion; interaction-level captures inherit owner aliases", () => {
    const interaction = makeInteraction(); interaction.members[1].deletionKeys = [key(2)];
    rejects(() => validateInteraction(interaction), "missing-parent-deletion-alias");
    const observation = makeObservation("returned-status"); observation.deletionKeys = [key(2)];
    rejects(() => validateObservationForInteraction(observation, makeInteraction(), defaultConsent()), "missing-owner-deletion-alias");
    const answer = makeObservation("answer"), captured = makeInteraction(); captured.basis.consentRevision = 1;
    answer.deletionKeys = [key(1)];
    rejects(() => validateObservationForInteraction(answer, captured, enabledConsent()), "missing-owner-deletion-alias");
});
