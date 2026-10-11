import test from "node:test";
import assert from "node:assert/strict";
import { REPORT_CONTEXT_BOUNDARY, REPORT_CONTEXT_LIMITATION, validateReportContext } from "../lib/report-context-shape.mjs";
import { reportContextHtml, reportContextMarkdown } from "../lib/report-context-output.mjs";

function snapshot() {
    const scenarioRef = "scenario-" + "a".repeat(16), key = `${scenarioRef}:context-response:observation-${"b".repeat(32)}`;
    const text = "Three invented documents.\n<script>not executable</script>";
    return { promptMode: "masked", records: [{ scenarioId: scenarioRef }], recordedContext: {
        schemaVersion: 1, boundary: REPORT_CONTEXT_BOUNDARY, limitation: REPORT_CONTEXT_LIMITATION,
        anchors: [{ scenarioRef, groups: [{ scenarioRef, relation: "selected", entryKeys: [key] }], entryKeys: [key],
            gaps: ["Available retained context only."], authorExcludedGroups: 0 }],
        entries: [{ key, scenarioRef, eventRef: null, observationRef: "observation-" + "b".repeat(32), kind: "response",
            timeStatus: "unknown", status: "partial", representation: "masked-copy", text, omitted: false, changes: [],
            label: "Recorded reply", finality: "unverified" }],
        coverage: { groups: 1, entries: 1, included: 1, omitted: 0, unavailable: 0, partial: 1,
            authorExcludedGroups: 0, sourceBytes: Buffer.byteLength(text), projectedBytes: Buffer.byteLength(text) },
    } };
}

test("frozen context adapters preserve text, original group, unknown time and finality without executable HTML", () => {
    const value = snapshot();
    assert.equal(validateReportContext(value.recordedContext, value.records, value.promptMode), value.recordedContext);
    const html = reportContextHtml(value), markdown = reportContextMarkdown(value).join("\n");
    assert.match(html, /&lt;script&gt;not executable&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>/);
    for (const text of [html, markdown]) {
        assert.match(text, /chronological position unknown/);
        assert.match(text, /finality unverified/);
        assert.match(text, /Original group: scenario-a+/);
        assert.match(text, /Each verdict stays with its original interaction/);
        assert.match(text, /Only part of the recorded text/);
    }
    assert.match(markdown, /    <script>not executable<\/script>/);
});

test("closed frozen context rejects widened scope, fabricated finality, extra fields and false counts", () => {
    for (const change of [
        value => { value.recordedContext.entries[0].finality = "final"; },
        value => { value.recordedContext.entries[0].reason = "Invented causal narrative"; },
        value => { value.recordedContext.anchors[0].scenarioRef = "scenario-" + "c".repeat(16); },
        value => { value.recordedContext.coverage.included = 4; },
        value => { value.promptMode = "none"; },
        value => { value.promptMode = "unsupported"; },
        value => { value.recordedContext.entries[0].status = "unavailable"; },
        value => { value.recordedContext.entries[0].authorship = { actor: "agent", basis: "source-agent" }; },
    ]) {
        const value = snapshot();
        change(value);
        assert.throws(() => validateReportContext(value.recordedContext, value.records, value.promptMode), /Invalid frozen report context/);
    }
});
