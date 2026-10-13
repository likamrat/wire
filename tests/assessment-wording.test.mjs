import test from "node:test";
import assert from "node:assert/strict";
import { createAssessmentWording, createAssessmentPresentation } from "../web/assessment-presentation.mjs";
import { createReportComparison } from "../web/report-comparison.mjs";
import { createControlHelp } from "../lib/control-help.mjs";
import { serviceCategories } from "../lib/service-categories.mjs";
import { adaptReportMetric } from "../lib/report-facts.mjs";
import { normalizeMetricFact } from "../lib/report-metric-comparison.mjs";
import { contract, quality } from "./assessment-ui-fixtures.mjs";
import { compareFrozenReportFacts } from "../lib/frozen-report-comparison.mjs";
import { renderComparisonHtml, renderComparisonMarkdown } from "../lib/report-presentation.mjs";
import { compareMetricFacts } from "../lib/report-metric-comparison.mjs";

const wording = createAssessmentWording(), presentation = createAssessmentPresentation(contract), format = createReportComparison();
const identity = { dimension: "action-trust", checkId: "action-intent-alignment", checkVersion: 1, origin: "model-assessed" };
const fact = input => normalizeMetricFact(adaptReportMetric(input));
function modelMetric() {
    const metric = quality("action-trust", { pass: 1, fail: 1, unassessed: 2, personal: true });
    Object.assign(metric, { checkId: "action-intent-alignment", origin: "model-assessed",
        evaluator: { provider: "github-copilot", model: "invented-model", rubricId: "wire-recorded-interaction-review", rubricVersion: 1 } });
    return contract.validateMetric(metric);
}

function sideComparison(a, b) {
    const report = (id, metric) => ({
        schemaVersion: 1, bundleId: `export-${id}`, snapshotHash: id.repeat(64), disclosureReviewed: true, patternVersion: 1,
        metrics: metric ? [metric] : [], toolRows: [{ id: "invented-call", patternId: "read", outcome: "success" }],
        scope: { selectionKind: "selected", timeZone: "UTC", collectionDefinition: "invented", callTimesAvailable: false, historyComplete: false },
    });
    return compareFrozenReportFacts(report("a", a), report("b", b));
}

test("F13 follow-up retains both definition versions on their own sides of real saved comparisons", () => {
    const raw = version => {
        const value = adaptReportMetric(modelMetric());
        value.qualifiers.checkVersion = version;
        return value;
    };
    for (const [a, b] of [[1, 2], [2, 3], [2, 1]]) {
        const inputs = [raw(a), raw(b)], before = JSON.stringify(inputs);
        const model = sideComparison(...inputs), row = model.metrics.find(item => item.metric === "action-trust");
        assert.equal(row.status, "incompatible"); assert.equal(row.delta, null);
        assert.doesNotMatch(format.definitionLabel(row), /Saved check|check version/, "Different definitions cannot share the earlier side's identity");
        for (const [side, version, other] of [["baseline", a, b], ["later", b, a]]) {
            const shown = format.comparisonSidePresentation(row, side);
            assert.equal(shown.value, "50%");
            assert.match(shown.note, /action-intent-alignment/);
            assert.ok(shown.note.includes(`check version ${version}`));
            assert.ok(!shown.note.includes(`check version ${other}`));
            assert.match(shown.note, /1 of 2 passed.*2 of 4 assessed/);
        }
        const snapshot = { bundleId: "export-side-proof", preparedAtDisplay: "Invented side definitions", sourceReports: [model.baseline, model.later] };
        for (const output of [renderComparisonHtml(model, snapshot), renderComparisonMarkdown(model, snapshot)]) {
            assert.ok(output.includes(`check version ${a}`));
            assert.ok(output.includes(`check version ${b}`));
        }
        assert.equal(JSON.stringify(inputs), before);
    }
});

test("F13 follow-up handles missing, conflicting and identical side definitions without borrowing identity", () => {
    const raw = adaptReportMetric(modelMetric());
    const future = { ...raw, qualifiers: { ...raw.qualifiers, checkVersion: 2 } };
    const missing = { ...raw, qualifiers: {} };
    const conflict = { ...raw, qualifiers: { ...raw.qualifiers, checkId: "action-authorization-compliance" } };
    for (const inputs of [[future, null], [null, future], [missing, conflict], [future, structuredClone(future)]]) {
        const before = JSON.stringify(inputs), model = sideComparison(...inputs);
        const row = model.metrics.find(item => item.metric === "action-trust");
        const shared = format.definitionLabel(row), same = inputs.every(Boolean) && JSON.stringify(inputs[0]) === JSON.stringify(inputs[1]);
        if (!same) assert.doesNotMatch(shared, /Saved check|check version/);
        for (const [index, side] of ["baseline", "later"].entries()) {
            const output = format.comparisonSidePresentation(row, side);
            if (!inputs[index]) {
                assert.equal(output.value, "Not saved");
                assert.doesNotMatch(output.note, /check version|action-intent-alignment/);
            } else {
                assert.equal(output.value, "50%");
                const text = same ? shared : output.note;
                if (!inputs[index].qualifiers.checkId) {
                    assert.match(text, /Check ID not recorded.*Check version not recorded/);
                    assert.doesNotMatch(text, /action-authorization-compliance/);
                } else {
                    assert.ok(text.includes(inputs[index].qualifiers.checkId));
                    assert.ok(text.includes(`check version ${inputs[index].qualifiers.checkVersion}`));
                }
                if (same) assert.doesNotMatch(output.note, /Saved check|check version/);
            }
        }
        assert.equal(JSON.stringify(inputs), before);
    }
    const sameTextA = { ...future, qualifiers: { ...future.qualifiers, evaluatorModel: "invented", rubricId: "first · rubric second" } };
    const sameTextB = { ...future, qualifiers: { ...future.qualifiers, evaluatorModel: "invented · rubric first", rubricId: "second" } };
    assert.equal(format.definitionLabel({ baseline: sameTextA }), format.definitionLabel({ baseline: sameTextB }));
    const distinct = sideComparison(sameTextA, sameTextB).metrics.find(item => item.metric === "action-trust");
    assert.equal(format.definitionLabel(distinct), "", "Only equal retained fields can be shared; formatted-text equality is insufficient");
    for (const side of ["baseline", "later"]) assert.match(format.comparisonSidePresentation(distinct, side).note, /Model assessment.*check version 2/);
});

test("comparison origin is shared once only when its heading owns identical retained metadata", () => {
    const known = adaptReportMetric(modelMetric());
    const future = { ...known, qualifiers: { ...known.qualifiers, checkVersion: 2 } };
    for (const value of [known, future]) {
        const pair = sideComparison(value, structuredClone(value)).metrics.find(item => item.metric === "action-trust");
        assert.match(format.definitionLabel(pair), /invented-model.*wire-recorded-interaction-review/);
        for (const side of ["baseline", "later"]) {
            const shown = format.comparisonSidePresentation(pair, side);
            assert.equal(shown.value, "50%");
            assert.match(shown.note, /1 of 2 passed.*2 of 4 assessed/);
            assert.doesNotMatch(shown.note, /Model assessment|invented-model|wire-recorded-interaction-review/);
            if (value === future) assert.match(shown.note, /saved definition does not identify/);
        }
    }
    const later = { ...known, qualifiers: { ...known.qualifiers, evaluatorModel: "different-model", rubricVersion: 7 } };
    const different = sideComparison(known, later).metrics.find(item => item.metric === "action-trust");
    assert.equal(format.definitionLabel(different), "");
    assert.match(format.comparisonSidePresentation(different, "baseline").note, /invented-model.*rubric.*v1/);
    assert.match(format.comparisonSidePresentation(different, "later").note, /different-model.*rubric.*v7/);
    assert.equal(different.status, "incompatible");
    assert.equal(different.delta, null);
    const absent = sideComparison(known, null).metrics.find(item => item.metric === "action-trust");
    assert.equal(format.definitionLabel(absent), "");
    assert.match(format.comparisonSidePresentation(absent, "baseline").note, /invented-model/);
    assert.doesNotMatch(format.comparisonSidePresentation(absent, "later").note, /invented-model/);
});

test("F13 follow-up warning copy describes missing results and decreasing proportions, not absent attempts", () => {
    const earlier = adaptReportMetric(modelMetric());
    const later = { ...earlier, numerator: 2, denominator: 4, coverage: { count: 4, eligible: 20 },
        counts: { pass: 2, fail: 2, unassessed: 16, evaluatorError: 0 } };
    const before = JSON.stringify([earlier, later]), comparison = compareMetricFacts(earlier, later);
    assert.deepEqual(comparison.warnings, ["partial-coverage", "coverage-decreased"]);
    assert.ok(later.coverage.count > earlier.coverage.count);
    assert.equal(comparison.delta.value, 0);
    assert.deepEqual(comparison.warnings.map(code => format.warningLabel(code, comparison)), [
        "Some requests lack review results", "Smaller share with review results",
    ]);
    for (const reason of ["missing-evidence", "evaluator-failure"]) {
        const attempted = { ...earlier, state: "unavailable", reason, coverage: { count: 0, eligible: 4 },
            numerator: null, denominator: null, counts: { pass: 0, fail: 0, unassessed: reason === "missing-evidence" ? 4 : 0,
                evaluatorError: reason === "evaluator-failure" ? 4 : 0 } };
        const row = compareMetricFacts(earlier, attempted);
        assert.deepEqual(row.warnings.map(code => format.warningLabel(code, row)), [
            "Some requests lack review results", "Smaller share with review results",
        ]);
        assert.doesNotMatch(row.warnings.map(code => format.warningLabel(code, row)).join(" "), /not reviewed|unreviewed/);
    }
    const timing = boundary => ({ metric: "speed", kind: "duration", definitionId: "invented-duration", definitionVersion: 1,
        unit: "ms", basis: "observed", aggregation: "median", boundary, state: "available",
        coverage: { count: 1, eligible: 2 }, value: 500 });
    for (const [boundary, missing] of [["tool-start-to-completion", "Some calls lack timing"],
        ["recorded-request-to-final-answer", "Some requests lack timing"], ["http-dispatch-to-response-headers", "Some HTTP records lack timing"]]) {
        const row = compareMetricFacts(timing(boundary), timing(boundary));
        assert.equal(format.warningLabel("partial-coverage", row), missing);
        assert.equal(format.warningLabel("coverage-decreased", row), "Smaller share with timing");
    }
    for (const row of [compareMetricFacts(earlier, timing("tool-start-to-completion")),
        compareMetricFacts(timing("tool-start-to-completion"), timing("recorded-request-to-final-answer"))]) {
        assert.equal(row.status, "incompatible");
        assert.equal(row.delta, null);
        assert.equal(format.warningLabel("partial-coverage", row), "Some items lack results");
        assert.equal(format.warningLabel("coverage-decreased", row), "Smaller share with results");
    }
    const cost = { kind: "cost", boundary: "explicit-attributed-usage-scope" };
    assert.equal(format.warningLabel("partial-coverage", cost), "Some units lack cost data");
    assert.equal(format.warningLabel("coverage-decreased", cost), "Smaller share with cost data");
    assert.equal(format.warningLabel("future-warning", comparison), "Saved warning: future-warning");
    assert.equal(JSON.stringify([earlier, later]), before);
});

test("F13 one serializable resolver distinguishes matching from permission in all fact shapes", () => {
    const restored = Function(`return (${createAssessmentWording.toString()})();`)();
    const input = [identity,
        { ...identity, origin: "user-personal", checkId: "action-authorization-compliance" },
        { ...identity, origin: "automatic-local", checkId: "action-authorization-compliance" }];
    assert.deepEqual(input.map(item => wording.resolve(item).label), ["Tool use vs. request", "Permission for tool use", "Permission for tool use"]);
    assert.deepEqual(input.map(item => wording.resolve(item).pass), ["Matched request", "Given", "Passed"]);
    for (const item of input) {
        const before = structuredClone(item);
        const report = { metric: item.dimension, basis: { "model-assessed": "model-assessment", "user-personal": "user-assessment", "automatic-local": "automatic-assessment" }[item.origin],
            qualifiers: { checkId: item.checkId, checkVersion: item.checkVersion } };
        const row = { dimension: item.dimension, provenance: { origin: item.origin, checkId: item.checkId, checkVersion: item.checkVersion } };
        assert.deepEqual(wording.resolve(item), restored.resolve(report));
        assert.deepEqual(wording.resolve(item), wording.resolve(row));
        assert.deepEqual(item, before);
    }
});

test("F13 absent, future and contradictory definitions remain unknown instead of inferred from dimension", () => {
    for (const item of [
        { dimension: "action-trust" }, { ...identity, checkVersion: 2 }, { ...identity, checkVersion: undefined },
        { ...identity, checkId: "future-check" }, { ...identity, origin: "user-personal" },
        { ...identity, origin: "automatic-local" }, { ...identity, checkId: "action-authorization-compliance" },
        { ...identity, dimension: "accuracy" }, { metric: "action-trust", basis: "mixed-assessment" },
        { metric: "action-trust", basis: "model-assessment", qualifiers: { checkId: "action-intent-alignment", checkVersion: 99 } },
    ]) {
        const term = wording.resolve(item);
        assert.equal(term.known, false);
        assert.equal(term.label, "Saved review (type not recorded)");
        assert.equal(term.pass, "Passed");
        if ((item.dimension ?? item.metric) === "action-trust") assert.equal(term.explanation,
            "The saved definition does not identify whether this reviewed request matching or permission.");
    }
});

test("F13 unavailable language retains origin, insufficient evidence and review-error distinctions", () => {
    const local = quality("action-trust");
    assert.equal(presentation.format(local).value, "Not checked automatically");
    const legacyAvailable = { ...fact(quality("action-trust", { pass: 1, unassessed: 0, personal: true })), basis: "automatic-assessment" };
    assert.equal(format.metricPresentation(legacyAvailable, "action-trust").value, "100%");
    assert.equal(wording.resolve(legacyAvailable).pass, "Passed", "No automated permission grant wording");
    const model = modelMetric();
    for (const [reason, expected] of [["no-assessed-units", "No saved review"], ["missing-evidence", "Not enough saved evidence"],
        ["partial-evidence", "Not enough saved evidence"], ["evaluator-failure", "Review could not finish"], ["not-applicable", "Not applicable"]]) {
        const unavailable = { ...fact(model), state: "unavailable", reason, value: null };
        assert.equal(format.metricPresentation(unavailable, "action-trust").value, expected);
        assert.equal(wording.unavailable({ ...identity, reason }), expected);
    }
    assert.equal(wording.unavailable({ ...identity, origin: "user-personal", checkId: "action-authorization-compliance", reason: "user-verdict" }), "Not sure");
    const insufficient = modelMetric();
    Object.assign(insufficient, { numerator: 0, denominator: 0, value: null, status: "unassessed", reason: "missing-evidence",
        counts: { pass: 0, fail: 0, unassessed: 4, evaluatorError: 0 }, coveredUnitRefs: [], coverage: { covered: 0, eligible: 4 } });
    assert.match(presentation.summarize([insufficient]).takeaway, /Saved reviews have no pass or fail verdicts/);
    assert.doesNotMatch(presentation.summarize([insufficient]).takeaway, /No saved review/);
});

test("F13 mixed same-dimension reviews keep exact independent percentages, counts, provenance and input bytes", () => {
    const model = modelMetric(), personal = quality("action-trust", { pass: 1, fail: 1, unassessed: 2, personal: true });
    const local = quality("action-trust", { unassessed: 4 });
    const metrics = [local, personal, model], before = JSON.stringify(metrics);
    const shown = presentation.summarize(metrics);
    assert.equal(shown.evidence.quality["action-trust"].assessed, 2);
    assert.equal(shown.evidence.quality["action-trust"].overlappingAssessments, true);
    assert.deepEqual(shown.evidence.quality["action-trust"].rows.map(row => row.passShare.value), [.5, .5]);
    assert.deepEqual(shown.evidence.quality["action-trust"].rows.map(row => row.label), ["Permission for tool use", "Tool use vs. request"]);
    assert.match(JSON.stringify(shown.findings.answers), /Your feedback.*Permission.*Given/);
    assert.match(JSON.stringify(shown.findings.answers), /Saved AI review.*Tool use.*Matched request/);
    for (const metric of [model, personal]) {
        const saved = fact(metric), raw = JSON.stringify(saved);
        const withOrigin = format.metricPresentation(saved, metric.dimension);
        const compact = format.metricPresentation(saved, metric.dimension, { includeOrigin: false });
        assert.equal(withOrigin.value, "50%"); assert.equal(compact.value, "50%");
        assert.equal(withOrigin.tone, compact.tone);
        assert.match(compact.note, /1 of 2 passed.*2 of 4 assessed.*2 not assessed/);
        assert.doesNotMatch(compact.note, /invented-model|Your feedback|Model assessment/);
        assert.equal(JSON.stringify(saved), raw);
    }
    assert.equal(JSON.stringify(metrics), before);
});

test("F13 comparison headings do not borrow request-matching meaning for personal or old saved facts", () => {
    const model = fact(modelMetric()), personal = fact(quality("action-trust", { pass: 1, unassessed: 0, personal: true }));
    const pair = { metric: "action-trust", baseline: model, later: personal };
    assert.equal(format.comparisonLabel(pair), "Different saved reviews");
    assert.match(format.comparisonSidePresentation(pair, "baseline").note, /^Tool use vs. request/);
    assert.match(format.comparisonSidePresentation(pair, "later").note, /^Permission for tool use.*Your feedback/);
    const legacy = { ...model, qualifiers: {} }, before = JSON.stringify(legacy);
    assert.equal(format.metricLabel(legacy), "Saved review (type not recorded)");
    assert.match(format.metricPresentation(legacy, "action-trust").note, /saved definition does not identify/);
    assert.doesNotMatch(format.metricPresentation(legacy, "action-trust").note, /tool use matched the request/);
    assert.equal(JSON.stringify(legacy), before);
    assert.match(format.definitionLabel({ baseline: legacy }), /Model assessment.*Check ID not recorded.*Check version not recorded/);
    const future = { ...legacy, qualifiers: { ...model.qualifiers, checkVersion: 2 } };
    assert.match(format.definitionLabel({ baseline: future }), /action-intent-alignment.*check version 2/);
    assert.notEqual(format.definitionLabel({ baseline: legacy }), format.definitionLabel({ baseline: future }));
    assert.equal(format.metricLabel(legacy), format.metricLabel(future));
});

test("F13 period warning and coverage language preserves distinct facts and unknown identities", () => {
    const codes = ["partial-coverage", "coverage-decreased", "total-cost-volume-differs", "future-warning"];
    const before = JSON.stringify(codes);
    assert.deepEqual(codes.map(format.warningLabel), [
        "Some items lack results", "Smaller share with results",
        "Different volume; not cost per task", "Saved warning: future-warning",
    ]);
    assert.equal(format.coverageUnit({ kind: "pass-rate" }), "requests");
    assert.equal(format.coverageUnit({ kind: "duration", boundary: "tool-start-to-completion" }), "calls");
    assert.equal(format.coverageUnit({ kind: "duration", boundary: "recorded-request-to-final-answer" }), "requests");
    assert.equal(format.coverageUnit({ kind: "duration", boundary: "http-dispatch-to-response-headers" }), "HTTP records");
    assert.equal(format.coverageUnit({ kind: "cost" }), "units");
    assert.equal(format.absentPeerLabel({ kind: "pass-rate" }), "No comparable saved review on this side");
    for (const kind of ["duration", "cost"]) assert.equal(format.absentPeerLabel({ kind }), "No comparable saved measure on this side");
    assert.equal(JSON.stringify(codes), before);
});

test("F13 help gives separate concise questions without changing the service and layer vocabulary", () => {
    const help = createControlHelp(serviceCategories, wording);
    assert.equal(help.glossary["action-trust"].label, "Tool use vs. request");
    assert.equal(help.glossary.permission.label, "Permission for tool use");
    assert.match(help.glossary["action-trust"].definition, /recorded tool use fit what was asked/);
    assert.match(help.glossary.permission.definition, /does not grant or revoke/);
    assert.match(help.layers["code-reference"], /references alone do not establish.*request ran/);
    assert.match(help.layers["reported-api"], /not directly observed/);
    assert.doesNotMatch(JSON.stringify(help.glossary), /AI action|Action trust/);
});
