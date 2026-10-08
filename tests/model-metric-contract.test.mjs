import test from "node:test";
import assert from "node:assert/strict";
import { validateMetric, metricSlotKey, poolMetrics } from "../lib/assessment-contract.mjs";
import { makeRatio, id, at } from "./assessment-contract-fixtures.mjs";
import { createWireMetricAdapter } from "../lib/wire-report-metric-adapter.mjs";
import * as contract from "../lib/assessment-contract.mjs";
import { compareMetricFacts } from "../lib/report-metric-comparison.mjs";
import { createAssessmentPresentation } from "../web/assessment-presentation.mjs";

function modelMetric(n = 1) {
    const metric = makeRatio(1, 1, n);
    Object.assign(metric, {
        dimension: "accuracy", checkId: "request-requirements-corroborated", origin: "model-assessed",
        evaluator: { provider: "github-copilot", model: "approved-model", rubricId: "wire-recorded-interaction-review", rubricVersion: 1 },
    });
    return metric;
}

test("model-assessed metrics remain explicitly labeled and cannot masquerade as local or personal results", () => {
    const metric = modelMetric();
    validateMetric(metric);
    const presented = createAssessmentPresentation(contract).format(metric);
    assert.equal(presented.origin, "Model assessment");
    const fact = createWireMetricAdapter(contract)(metric);
    assert.equal(fact.basis, "model-assessment");
    assert.equal(fact.qualifiers.evaluatorModel, "approved-model");
    assert.throws(() => validateMetric({ ...metric, origin: "automatic-local" }));
    assert.throws(() => validateMetric({ ...metric, origin: "user-personal" }));
});

test("model identity and rubric version partition pooling and frozen comparison", () => {
    const a = modelMetric(), b = modelMetric(20);
    b.evaluator.model = "another-model";
    assert.notEqual(metricSlotKey(a), metricSlotKey(b));
    assert.throws(() => poolMetrics([a, b], id("metric", 99), at), /incompatible-definitions/);
    const adapt = createWireMetricAdapter(contract);
    assert.equal(compareMetricFacts(adapt(a), adapt(b)).status, "incompatible");
});
