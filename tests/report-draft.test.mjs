import test from "node:test";
import assert from "node:assert/strict";
import { createReportDraft } from "../web/report-draft.mjs";
import { createRequestContext } from "../web/request-context.mjs";
import { retainedContextFixture } from "./request-context-fixture.mjs";

test("context authority belongs to the rendered revision, survives edits, and fences late copies without losing write receipts", () => {
    const draft = createReportDraft();
    const basis = { sourceRevision: 4, membershipRevision: 4, consentRevision: 1, overrideRevision: 0, deletionEpoch: 0 };
    const preview = { revision: 8, snapshot: { evaluationFacts: { basis }, recordedContext: {
        entries: [{ key: "reply-copy", kind: "response" }, { key: "prompt-copy", kind: "prompt" }],
    } } };
    assert.equal(draft.bindContext(preview), true);
    const contextToken = draft.contextToken();
    draft.change({ overrides: [{ key: "reply-copy", text: "Source-bound reply" }, { key: "prompt-copy", text: "Keep prompt edit" }] });
    draft.invalidate();
    assert.equal(draft.observeContext({ revision: 7, assessment: { basis: { ...basis, consentRevision: 0 } } }), false);
    assert.equal(draft.contextCurrent(contextToken), true, "An older status cannot clear this rendered preview");
    const writeToken = draft.token();
    assert.equal(draft.observeContext({ revision: 9, assessment: { basis: { ...basis, consentRevision: 2 } } }, { writing: true }), true);
    assert.equal(draft.current(writeToken), true, "Privacy clearing must not abandon an in-flight write receipt");
    assert.equal(draft.contextCurrent(contextToken), false);
    assert.deepEqual(draft.options().overrides, [{ key: "prompt-copy", text: "Keep prompt edit" }]);
    assert.equal(draft.bindContext(preview), false, "A delayed older preview cannot repopulate revoked context");
    assert.equal(draft.bindContext({ ...preview, revision: 10 }), false, "A newer transport revision cannot restore an older consent basis");
    assert.equal(draft.bindContext({ ...preview, revision: 10, snapshot: { ...preview.snapshot,
        evaluationFacts: { basis: { ...basis, consentRevision: 2 } } } }), true);
    const current = draft.contextToken(), token = draft.token();
    assert.equal(draft.observeContext({ revision: 9, assessment: { basis } }), false);
    assert.equal(draft.contextCurrent(current), true);
    assert.equal(draft.observeContext({ revision: 11, assessment: { basis } }), true);
    assert.equal(draft.current(token), false, "A context-only revision invalidates review outside a write");
});

test("context-only source changes invalidate a selected draft without losing contextual edits", () => {
    const draft = createReportDraft({ contextSelector: createRequestContext() });
    const { records } = retainedContextFixture();
    const request = { scenarioId: records[1].scenarioId, aliases: [records[1].scenarioId] };
    const scope = { requests: [request], baseRequests: [request] };
    const state = { boardId: "invented-context", revision: 1, deletionVersion: 0, scenarios: records };
    draft.change({ recordedContext: true, overrides: [{ key: "context-copy", text: "Kept edit" }] });
    draft.synchronizeBasis(state, scope);
    const token = draft.token(), changed = structuredClone(state);
    changed.scenarios[0].userPrompt.text = "Changed linked earlier request";
    assert.equal(draft.synchronizeBasis(changed, scope), true);
    assert.equal(draft.current(token), false);
    assert.equal(draft.options().overrides[0].text, "Kept edit");
    const revised = structuredClone(changed);
    revised.revision++;
    assert.equal(draft.synchronizeBasis(revised, scope), true, "Unavailable payload dependencies require conservative revision invalidation");
});

test("verified report basis ignores unrelated updates but detects same-count identity and content changes", () => {
    const draft = createReportDraft();
    const request = { scenarioId: "a", aliases: ["a"], counts: { tool: 1 } };
    const scope = { requests: [request], baseRequests: [request] };
    const state = { boardId: "invented", deletionVersion: 0, revision: 1, scenarios: [
        { scenarioId: "a", userPrompt: { text: "Included copy" } },
        { scenarioId: "b", userPrompt: { text: "Unrelated copy" } },
    ], assessment: { basis: { sourceRevision: 1, consentRevision: 0, overrideRevision: 0, deletionEpoch: 0 }, catalog: [] } };
    assert.equal(draft.synchronizeBasis(state, scope), false);
    draft.change({ overrides: [{ key: "copy-a", text: "Edited copy" }] });
    const token = draft.token();
    const unrelated = structuredClone(state);
    unrelated.revision++;
    unrelated.assessment.basis.sourceRevision++;
    unrelated.scenarios[1].userPrompt.text = "Unrelated update";
    assert.equal(draft.synchronizeBasis(unrelated, scope), false);
    assert.equal(draft.current(token), true);
    const changed = structuredClone(unrelated);
    changed.scenarios[0].userPrompt.text = "Changed included source";
    assert.equal(draft.synchronizeBasis(changed, scope), true);
    assert.equal(draft.current(token), false);
    assert.deepEqual(draft.options().overrides, [{ key: "copy-a", text: "Edited copy" }]);
    const swap = { ...request, scenarioId: "b", aliases: ["b"] };
    assert.equal(draft.synchronizeBasis(changed, { requests: [swap], baseRequests: [swap] }), true);
});

test("every report setting change invalidates the current review token without reusable consent", () => {
    const draft = createReportDraft();
    assert.equal(draft.options().promptMode, "masked");
    for (const patch of [{ promptMode: "original" }, { formats: ["pdf"] }, { manualTerms: ["Leila"] }, { overrides: [{ key: "p", omit: true }] }]) {
        const token = draft.token();
        draft.change(patch);
        assert.equal(draft.current(token), false);
        assert.equal(Object.hasOwn(draft.options(), "reviewed"), false);
    }
});

test("alias, permission, feedback, deletion and unverifiable model changes invalidate approval without losing copy edits", () => {
    const request = { scenarioId: "a", aliases: ["a"] };
    const scope = { requests: [request], baseRequests: [request] };
    const original = { boardId: "invented", revision: 1, deletionVersion: 0, scenarios: [{ scenarioId: "a" }],
        assessment: { source: { available: false }, consent: { revision: 0 }, basis: { consentRevision: 0, overrideRevision: 0, deletionEpoch: 0 }, catalog: [] } };
    for (const change of [
        value => { value.assessment.source.available = true; },
        value => { value.assessment.consent.revision++; },
        value => { value.assessment.basis.overrideRevision++; },
        value => { value.deletionVersion++; },
        value => { value.assessment.catalog.push({ scenarioId: "a", interactionRef: "changed-ref" }); },
        value => { value.assessment.overview = { metrics: [{ origin: "model-assessed" }] }; },
    ]) {
        const draft = createReportDraft();
        draft.synchronizeBasis(original, scope);
        draft.change({ overrides: [{ key: "a", text: "Preserved edit" }] });
        const token = draft.token(), changed = structuredClone(original);
        change(changed);
        assert.equal(draft.synchronizeBasis(changed, scope), true);
        assert.equal(draft.current(token), false);
        assert.equal(draft.options().overrides[0].text, "Preserved edit");
    }
    const draft = createReportDraft();
    draft.synchronizeBasis(original, scope);
    assert.equal(draft.synchronizeBasis(original, { ...scope, requests: [{ ...request, aliases: ["a", "new-alias"] }] }), true);
});

test("selection changes discard per-prompt edits but preserve deliberate masking terms and formats", () => {
    const draft = createReportDraft();
    draft.select(["a"]);
    draft.change({ overrides: [{ key: "p", omit: true }], manualTerms: ["Leila"], formats: ["html", "json"] });
    const token = draft.token();
    draft.select(["b"]);
    assert.equal(draft.current(token), false);
    assert.deepEqual(draft.options(), { promptMode: "masked", formats: ["html", "json"], manualTerms: ["Leila"], overrides: [] });
});

test("time context or date selection changes invalidate review without discarding prompt choices", () => {
    const draft = createReportDraft();
    draft.change({ promptMode: "original", formats: ["pdf"] });
    const context = { timeZone: "America/Los_Angeles", locale: "en-GB" };
    draft.synchronizeTime(context, { range: "custom", from: "2026-03-08", to: "2026-03-08" });
    const token = draft.token();
    draft.synchronizeTime(context, { range: "custom", from: "2026-03-08", to: "2026-03-08" });
    assert.equal(draft.current(token), true);
    draft.synchronizeTime({ ...context, timeZone: "Asia/Kolkata" }, { range: "capture" });
    assert.equal(draft.current(token), false);
    assert.equal(draft.options().promptMode, "original");
    assert.deepEqual(draft.options().formats, ["pdf"]);
    assert.equal(draft.options().timeContext.timeZone, "Asia/Kolkata");
});

test("clearing always invalidates in-flight review and per-copy edits, preserving prompt/format preferences", () => {
    const draft = createReportDraft();
    draft.select(["all", "a", "b"]);
    draft.change({ promptMode: "original", formats: ["html", "pdf"], manualTerms: ["Leila"], overrides: [{ key: "p", text: "Edited copy" }] });
    const token = draft.token();
    draft.clearSelection();
    assert.equal(draft.current(token), false);
    assert.deepEqual(draft.options(), { promptMode: "original", formats: ["html", "pdf"], manualTerms: ["Leila"], overrides: [] });
    const emptyToken = draft.token();
    draft.clearSelection();
    assert.equal(draft.current(emptyToken), false, "Even an already-empty selection invalidates outstanding work");
    assert.deepEqual(createReportDraft().options(), { promptMode: "masked", formats: ["html"], manualTerms: [], overrides: [] }, "Reload starts a fresh, non-persistent draft");
});
