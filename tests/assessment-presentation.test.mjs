import test from "node:test";
import assert from "node:assert/strict";
import { createAssessmentPresentation } from "../web/assessment-presentation.mjs";
import { contract, samples, quality, currentView, mixedOverview } from "./assessment-ui-fixtures.mjs";

const presentation = createAssessmentPresentation(contract);
const row = (model, dimension) => model.groups[dimension][0];
test("current adapter summary omits Cost and retains distinct answer/action trust", () => {
    const model = presentation.summarize(currentView().metrics);
    assert.deepEqual(Object.keys(model.groups), ["accuracy", "speed", "answer-trust", "action-trust"]);
    assert.equal(row(model, "accuracy").value, "Unassessed");
    assert.equal(row(model, "answer-trust").label, "Answer trust");
    assert.equal(row(model, "action-trust").label, "Action trust");
    assert.equal(row(model, "answer-trust").value, "Unassessed");
    assert.equal(row(model, "action-trust").value, "Unassessed");
    assert.equal(model.groups.cost, undefined);
    assert.match(model.takeaway, /Call timing is available/);
    assert.match(model.takeaway, /both kinds of trust are unassessed/);
});
test("recorded tool success never becomes accuracy, trust or a colored quality score", () => {
    const model = presentation.summarize([samples.makeRatio(8, 2)]);
    assert.equal(model.diagnostics[0].label, "Recorded tool completion");
    assert.equal(model.diagnostics[0].value, "80%");
    assert.equal(model.diagnostics[0].band, "neutral");
    assert.equal(row(model, "accuracy").value, "Unassessed");
    assert.equal(row(model, "answer-trust").band, "neutral");
    assert.equal(row(model, "action-trust").band, "neutral");
    assert.match(model.takeaway, /^2 \/ 10 tool completions with a recorded success\/failure result failed/);
    assert.doesNotMatch(model.takeaway, /assessed tool/);
});
test("automatic and personal accuracy remain distinct origin lanes with exact partial coverage", () => {
    const model = presentation.summarize([quality("accuracy"), quality("accuracy", { pass: 3, fail: 1, unassessed: 4, personal: true, offset: 20 })]);
    const rows = model.groups.accuracy;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].value, "Unassessed");
    assert.equal(rows[1].value, "75%");
    assert.equal(rows[1].origin, "Your feedback");
    assert.equal(rows[1].coverage, "3 / 4 passed; 4 / 8 assessed");
    assert.equal(rows[1].band, "gold");
});
test("opposed trust feedback is not averaged or blended", () => {
    const model = presentation.summarize([
        quality("answer-trust", { pass: 1, unassessed: 0, personal: true }),
        quality("action-trust", { fail: 1, unassessed: 0, personal: true }),
    ]);
    assert.equal(row(model, "answer-trust").value, "100%");
    assert.equal(row(model, "action-trust").value, "0%");
    assert.equal(model.groups.trust, undefined);
    assert.equal(model.overallScore, undefined);
});
test("single-interaction presentation uses personal verdict words without changing aggregate facts", () => {
    for (const [dimension, pass, fail] of [
        ["accuracy", "Correct", "Not correct"],
        ["answer-trust", "Supported", "Not supported"],
        ["action-trust", "Authorized", "Not authorized"],
    ]) {
        for (const positive of [true, false]) {
            const metric = quality(dimension, { pass: positive ? 1 : 0, fail: positive ? 0 : 1, unassessed: 0, personal: true });
            const before = structuredClone(metric);
            const aggregate = row(presentation.summarize([metric]), dimension);
            const detail = row(presentation.summarize([metric], { singleInteraction: true }), dimension);
            assert.equal(detail.value, positive ? pass : fail);
            assert.equal(aggregate.value, positive ? "100%" : "0%");
            assert.equal(detail.coverage, aggregate.coverage);
            assert.deepEqual(metric, before);
        }
    }
});
test("partial personal coverage and Not-sure semantics never become a binary single verdict", () => {
    const partial = quality("accuracy", { pass: 1, unassessed: 2, personal: true });
    assert.equal(row(presentation.summarize([partial], { singleInteraction: true }), "accuracy").value, "100%");
    const unassessed = quality("accuracy", { unassessed: 1, personal: true });
    const displayed = row(presentation.summarize([unassessed], { singleInteraction: true }), "accuracy");
    assert.equal(displayed.value, "Unassessed");
    assert.equal(displayed.personalVerdict, null);
    assert.equal(displayed.coverage, "0 / 1 assessed; no pass/fail results");
});
for (const [value, expected] of [[0, "red"], [0.4999, "red"], [0.5, "orange"], [0.7499, "orange"], [0.75, "gold"], [0.8999, "gold"], [0.9, "teal"], [1, "teal"], [null, "neutral"]]) {
    test(`visual band at ${value} is ${expected}, versioned independently from metrics`, () => {
        assert.equal(presentation.band(value), expected);
        assert.equal(presentation.bandVersion, "assessed-pass-share-v1");
    });
}
for (const invalid of [-1, 1.01, NaN, Infinity, undefined, "0.5"]) {
    test(`invalid ratio ${String(invalid)} is not rendered as a quality score`, () => assert.throws(() => presentation.band(invalid)));
}
test("no eligible items and eligible-but-unassessed items do not manufacture zero percent", () => {
    const empty = presentation.format(samples.makeRatio(0, 0, 0));
    const unassessed = presentation.format(samples.makeRatio(0, 0, 2));
    assert.equal(empty.value, "Unassessed");
    assert.equal(empty.coverage, "0 / 0 positive; 0 / 0 with a recorded binary result");
    assert.equal(unassessed.value, "Unassessed");
    assert.equal(unassessed.coverage, "0 / 0 positive; 0 / 2 with a recorded binary result");
});
test("a real zero and a small denominator remain visible facts", () => {
    const metric = quality("accuracy", { fail: 1, unassessed: 0, personal: true });
    const displayed = presentation.format(metric);
    assert.equal(displayed.value, "0%");
    assert.equal(displayed.coverage, "0 / 1 passed; 1 / 1 assessed");
    assert.doesNotMatch(displayed.qualification, /confidence|guaranteed|excellent|poor/i);
});
test("display rounding cannot turn a below-threshold share into the next color band", () => {
    const displayed = presentation.format(quality("accuracy", { pass: 3752, fail: 1251, unassessed: 0, personal: true }));
    assert.equal(displayed.value, "74.99%");
    assert.equal(displayed.band, "orange");
    assert.match(displayed.coverage, /3,752 \/ 5,003 passed/);
});
test("tiny positive shares and durations are not displayed as zero", () => {
    assert.equal(presentation.format(samples.makeRatio(1, 10000)).value, "<0.01%");
    assert.equal(presentation.format(samples.makeDuration([0.004])).value, "<0.01 ms");
});
test("evaluator failure is not a failed outcome or a zero score", () => {
    const displayed = presentation.format(samples.makeRatio(0, 0, 0, 1));
    assert.equal(displayed.value, "Check unavailable");
    assert.match(displayed.qualification, /not a failed result/);
    assert.match(displayed.details.join(" "), /0 failed, 0 unassessed, 1 check errors/);
});
test("malformed counts fail explicitly rather than displaying invented values", () => {
    const metric = samples.makeRatio(1);
    metric.denominator = 2;
    assert.throws(() => presentation.format(metric), /invalid-denominator/);
});
test("duplicate metric slots fail instead of silently taking a last value", () => {
    assert.throws(() => presentation.summarize([samples.makeRatio(), samples.makeRatio(1, 0, 0, 0, 20)]), /Duplicate metric slot/);
});
test("mixed source revisions cannot be combined into one summary", () => {
    const metric = samples.makeCost();
    metric.basis.sourceRevision++;
    assert.throws(() => presentation.summarize([samples.makeRatio(), metric]), /one current basis/);
});
test("legacy cost states remain formattable but are absent from current summaries", () => {
    const model = presentation.summarize(["measured", "estimated", "unpriced", "not-measured"].map(samples.makeCost));
    assert.equal(model.groups.cost, undefined);
    assert.deepEqual(["measured", "estimated", "unpriced", "not-measured"].map(state => presentation.format(samples.makeCost(state)).value),
        ["$0.25", "$0.25", "Unpriced", "Not measured"]);
});
test("real zero measured cost is different from missing or tiny nonzero cost", () => {
    const metric = samples.makeCost("measured");
    metric.value = 0;
    assert.equal(presentation.format(metric).value, "$0.00");
    metric.value = 0.000004;
    assert.equal(presentation.format(metric).value, "$0.000004");
    metric.value = 0.000000004;
    assert.equal(presentation.format(metric).value, "<$0.000001");
    assert.equal(presentation.format(samples.makeCost()).value, "Not measured");
});
test("partially priced cost is a subtotal, not whole-interaction spend", () => {
    const metric = samples.makeCost("estimated");
    metric.eligibleUnitRefs = [...metric.eligibleUnitRefs, samples.id("record", 2)];
    metric.coverage.eligible++;
    metric.observedTime.undatedUnits++;
    assert.match(presentation.format(metric).qualification, /^Estimated subtotal \(USD\)/);
    assert.equal(presentation.format(metric).coverage, "1 / 2 priced");
});
test("pricing versions partition costs instead of blending them", () => {
    const first = samples.makeCost("estimated"), second = samples.makeCost("estimated");
    second.pricing.version = 2;
    second.metricRef = samples.id("metric", 99);
    assert.equal(presentation.summarize([first, second]).groups.cost, undefined);
    assert.notEqual(contract.metricSlotKey(first), contract.metricSlotKey(second));
});
test("call latency displays the backend median, not a sum or a recomputed average", () => {
    const metric = samples.makeDuration([1, 2, 100000]);
    const displayed = presentation.format(metric);
    assert.equal(displayed.value, "2 ms");
    assert.equal(displayed.label, "Median call duration");
    assert.equal(displayed.qualification, "Call start to recorded completion");
    assert.deepEqual(displayed.summary, { label: "Tool calls", coverage: "Median \u00b7 3 / 3 calls timed" });
    assert.equal(displayed.band, "neutral");
});
test("compact final-response copy preserves full definitions, numeric values and exact request coverage", () => {
    const metric = samples.makeDuration([114247, 677960]);
    Object.assign(metric, {
        definitionId: "recorded-response-duration",
        boundary: contract.DEFINITIONS["recorded-response-duration"].boundary,
        measurementBasis: contract.DEFINITIONS["recorded-response-duration"].basis,
    });
    const original = structuredClone(metric);
    const displayed = presentation.format(metric);
    assert.deepEqual(displayed.summary, { label: "Request to final response", coverage: "Median \u00b7 2 / 2 requests timed" });
    assert.equal(displayed.value, "114,247 ms");
    assert.equal(displayed.label, "Time to recorded final response");
    assert.match(displayed.details.join(" "), /Recorded request to final response; not tool-call time/);
    assert.deepEqual(metric, original);
});
test("different timing boundaries remain separate with units and explicit measurement boundaries", () => {
    const first = samples.makeDuration([1042]), second = samples.makeDuration([40]);
    Object.assign(second, {
        definitionId: "http-response-duration",
        boundary: contract.DEFINITIONS["http-response-duration"].boundary,
        measurementBasis: contract.DEFINITIONS["http-response-duration"].basis,
        metricRef: samples.id("metric", 2),
    });
    const model = presentation.summarize([first, second]);
    assert.equal(model.groups.speed.length, 2);
    assert.equal(model.groups.speed[0].value, "1,042 ms");
    assert.equal(model.groups.speed[1].value, "40 ms");
    assert.equal(model.groups.speed[1].qualification, "Dispatch to response headers");
});
test("missing whole-interaction boundaries stay unavailable even when call timings exist", () => {
    const model = presentation.summarize(currentView().metrics);
    assert.equal(model.groups.speed[1].label, "Whole-interaction latency");
    assert.equal(model.groups.speed[1].value, "Not measured");
});
test("partial and conflicting membership lead with retained-scope limits", () => {
    for (const membershipStatus of ["partial", "unverified"]) {
        const model = presentation.summarize(currentView().metrics, { membershipStatus });
        assert.match(model.takeaway, /Only part of this interaction can be attributed/);
    }
});
test("summary projection never mutates source facts and needs no answer text", () => {
    const view = currentView(), before = structuredClone(view);
    presentation.summarize(view.metrics);
    assert.deepEqual(view, before);
    assert.ok(view.observations.every(observation => observation.kind !== "answer"));
});
test("mixed aggregate fixture is valid but not passed off as an interaction", () => {
    const metrics = mixedOverview();
    metrics.forEach(contract.validateMetric);
    assert.equal(presentation.summarize(metrics).groups.cost, undefined);
    assert.throws(() => contract.validateInteractionView({ ...currentView(), metrics }), /stale-|metric-outside-interaction|duplicate-identity/);
});
