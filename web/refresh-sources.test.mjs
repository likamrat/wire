import test from "node:test";
import assert from "node:assert/strict";
import { createRefreshSources } from "./refresh-sources.mjs";

const view = ({ microsoft = true, paused = false, generation = 7, configurationRevision = 3 } = {}) => ({
    current: true,
    status: {
        generation, authorizationRevision: 12,
        global: { state: "committed", revision: 2, paused },
        github: { status: { configVersion: "github-config", config: { approved: true, enabled: false, windowDays: 30 } } },
        microsoft: { status: { configured: true, accountRef: "account-partition",
            configuration: { configurationRevision, privacyRevision: 4, surfaces: ["chat", "cowork"], settings: { paused: false, windowDays: 30 } } } },
    },
    actions: { github: ["collect-now"], microsoft: microsoft && !paused ? ["collect-now"] : [] },
});

test("a gesture captures both source bases and never expands a skipped Microsoft branch", () => {
    const sources = createRefreshSources();
    const original = view({ paused: true });
    const plan = sources.capture(original);
    assert.deepEqual(plan.github.expectedBasis, { generation: 7, configVersion: "github-config" });
    assert.equal(plan.github.admitted, true, "GitHub retains its existing manual exception while globally paused");
    assert.equal(plan.microsoft.admitted, false);
    assert.equal(plan.microsoft.reason, "paused");
    assert.equal(sources.admission(plan, "microsoft", view()).allowed, false);
    original.status.github.status.configVersion = "changed-after-capture";
    assert.equal(plan.github.expectedBasis.configVersion, "github-config");
    const both = sources.capture(view());
    assert.deepEqual(both.microsoft.expectedBasis, {
        generation: 7, accountRef: "account-partition", configurationRevision: 3, privacyRevision: 4, globalRevision: 2,
    });
    assert.equal(sources.admission(both, "microsoft", view({ configurationRevision: 5 })).allowed, false);
});

test("source outcomes never turn a skip or an unknown result into a both-source success", () => {
    const sources = createRefreshSources();
    const github = { state: "settled", result: { phase: "complete", check: { changes: { added: 0, updated: 0 }, outcome: "complete" } } };
    let summary = sources.describe({ github, microsoft: { state: "skipped", reason: "paused" } });
    assert.equal(summary.message, "GitHub: no additional activity. Microsoft: not checked (paused).");
    assert.equal(summary.recovery, false);
    summary = sources.describe({ github, microsoft: { state: "settled", result: {
        phase: "unconfirmed", sourceUnknown: true, nativeOperationId: "original-native",
    } } });
    assert.equal(summary.message, "GitHub: no additional activity. Microsoft: result unconfirmed.");
    assert.equal(summary.recovery, true);
    assert.deepEqual(github.result.check.changes, { added: 0, updated: 0 });
    summary = sources.describe({ github, microsoft: { state: "settled", result: {
        phase: "complete", nativeReceipt: { status: "committed", quality: "source-qualified-partial" },
    } } });
    assert.equal(summary.message, "GitHub: no additional activity. Microsoft: activity saved.");
    assert.equal(summary.coverage, "Microsoft: partial history.");
    assert.equal(summary.recovery, false);
});

test("the serialized source policy preserves pending and partial outcomes without inventing success", () => {
    const sources = Function(`return (${createRefreshSources.toString()})()`)();
    const summary = sources.describe({
        github: { state: "settled", result: { phase: "complete", check: { changes: { added: 1, updated: 0 }, outcome: "partial" } } },
        microsoft: { state: "settled", result: { phase: "unconfirmed", sourceUnknown: true, nativeReceipt: { status: "pending" } } },
    });
    assert.equal(summary.message, "GitHub: 1 new activity record. Microsoft: still pending.");
    assert.equal(summary.coverage, "GitHub: incomplete history.");
    assert.equal(summary.recovery, true);
    assert.throws(() => sources.names.push("another-source"), TypeError);
});
