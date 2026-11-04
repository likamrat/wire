import test from "node:test";
import assert from "node:assert/strict";
import { createReportDraft } from "../web/report-draft.mjs";
import { createRequestContext } from "../web/request-context.mjs";
import { retainedContextFixture } from "./request-context-fixture.mjs";

test("native report drafts bind distinct original Current/All receipts and independent GitHub IDs across content edits", () => {
    const draft = createReportDraft();
    const view = { status: "bounded", revision: 7, sourceRevision: "a".repeat(64), viewId: "b".repeat(64), allViewId: "c".repeat(64),
        definitions: { unit: "native calls" }, readback: { current: { generation: 2 } }, aggregates: { complete: true, conversations: 8 } };
    const scope = { kind: "current", revision: 7, scenarioIds: ["github-one"] }, intent = { layer: "tool", filters: { sources: ["microsoft-365-chat"] } };
    draft.bindNativeView(view, scope, intent);
    assert.deepEqual(draft.nativeView(view, 7, intent).request, { nativeViewId: view.viewId, selection: scope });
    draft.change({ title: "Edited report", promptMode: "none" });
    assert.equal(draft.nativeView(view, 7, intent).conversationCount, 8);
    const nextPage = { ...view, viewId: "d".repeat(64), allViewId: "e".repeat(64), page: { items: [] } };
    assert.equal(draft.nativeView(nextPage, 7, intent).request.nativeViewId, view.viewId, "Paging/new equivalent receipt does not replace the original binding");
    draft.bindNativeView(view, { kind: "all", revision: 7 }, intent);
    assert.equal(draft.nativeView(view, 7, intent).request.nativeViewId, view.allViewId);
    assert.equal(draft.nativeView(view, 7, intent).conversationCount, null, "Filtered Current totals are not an All count");
});

test("native report draft invalidation never silently rebinds stale source/filter intent or restores a refused receipt", () => {
    const draft = createReportDraft();
    const view = { status: "bounded", revision: 7, sourceRevision: "a".repeat(64), viewId: "b".repeat(64), allViewId: "c".repeat(64),
        definitions: {}, readback: { current: { generation: 2 } }, aggregates: { complete: true, conversations: 1 } };
    const scope = { kind: "current", revision: 7, scenarioIds: [] }, intent = { layer: "tool", filters: {} };
    draft.bindNativeView(view, scope, intent);
    assert.equal(draft.nativeView({ ...view, revision: 8 }, 8, intent).ready, false);
    assert.equal(draft.nativeView(view, 7, intent).ready, false, "Stale state cannot revive an earlier receipt");
    draft.bindNativeView(view, scope, intent);
    assert.equal(draft.nativeView(view, 7, { ...intent, filters: { outcomes: ["failure"] } }).ready, false);
    draft.bindNativeView(view, scope, intent);
    draft.rejectNativeView();
    assert.equal(draft.nativeView(view, 7, intent).ready, false);
    draft.bindNativeView(view, scope, intent);
    draft.withdrawAccess();
    assert.equal(draft.nativeView(view, 7, intent).ready, false);
    draft.resumeAccess();
    assert.equal(draft.nativeView(view, 7, intent).ready, false);
    assert.throws(() => draft.bindNativeView({ ...view, allViewId: undefined }, scope, intent), TypeError);
});

test("native report bindings retain original group and text intent rather than rebasing a refined preview", () => {
    const draft = createReportDraft();
    const view = { status: "bounded", revision: 7, sourceRevision: "a".repeat(64), viewId: "b".repeat(64), allViewId: "c".repeat(64),
        definitions: {}, readback: { current: { generation: 2 } }, aggregates: { complete: true, conversations: 1 } };
    const intent = { nativeGroup: "d".repeat(64), nativeQuery: "term", nativeTextMembership: "e".repeat(64) };
    draft.bindNativeView(view, { kind: "current", revision: 7, scenarioIds: [] }, intent);
    draft.change({ title: "Edited title" });
    assert.equal(draft.nativeView(view, 7, intent).request.nativeViewId, view.viewId);
    assert.equal(draft.nativeView(view, 7, { ...intent, nativeQuery: "replacement" }).ready, false);
    draft.bindNativeView(view, { kind: "current", revision: 7, scenarioIds: [] }, intent);
    assert.equal(draft.nativeView(view, 7, { ...intent, nativeGroup: null }).ready, false);
});

test("native Selected keeps only exposed conversation IDs and its original view across pages and edits", () => {
    const draft = createReportDraft(), owner = {};
    const item = { id: "d".repeat(64), sourceId: "microsoft-365-chat" };
    const view = { status: "bounded", revision: 7, sourceRevision: "a".repeat(64), viewId: "b".repeat(64), allViewId: "c".repeat(64),
        selectionRef: "e".repeat(64), definitions: {}, readback: { current: { generation: 2 } },
        aggregates: { complete: true, conversations: 2 }, page: { items: [item] } };
    assert.throws(() => draft.selectNative(view, "f".repeat(64), true, owner), /current Microsoft page/);
    draft.selectNative(view, item.id, true, owner);
    const next = { ...view, viewId: "f".repeat(64), page: { items: [{ id: "0".repeat(64), sourceId: "microsoft-365-cowork" }] } };
    draft.selectNative(next, next.page.items[0].id, true, owner);
    const picked = draft.nativeSelection(next, 7, owner);
    assert.deepEqual(picked.items.map(value => value.id), [item.id, next.page.items[0].id]);
    assert.equal(picked.view.viewId, view.viewId);
    const scope = { kind: "selected", revision: 7, scenarioIds: ["github-one", ...picked.items.map(value => value.id)] };
    draft.bindNativeView(picked.view, scope, { nativeSelected: scope.scenarioIds.slice(1) });
    draft.change({ title: "Edited report" });
    assert.deepEqual(draft.nativeView(next, 7, { nativeSelected: scope.scenarioIds.slice(1) }).request,
        { nativeViewId: view.viewId, selection: scope });
    assert.equal(draft.nativeView(next, 7, { nativeSelected: scope.scenarioIds.slice(1) }).conversationCount, 2);
    assert.throws(() => draft.selectNative({ ...next, selectionRef: "1".repeat(64) }, item.id, true, owner), /different view|current Microsoft page/);
    assert.equal(draft.nativeSelection({ ...next, revision: 8 }, 8, owner).ready, false);
    assert.equal(draft.nativeSelection(view, 7, owner).ready, false, "A changed root/revision never revives old picks.");
    draft.clearSelection();
    draft.selectNative(view, item.id, true, owner);
    assert.equal(draft.nativeSelection(view, 7, {}).ready, false);
    draft.withdrawAccess(); draft.resumeAccess();
    assert.equal(draft.nativeSelection(view, 7, owner).hasSelection, false);
});

test("native frozen copies bind disclosure to the actual report revision without invented metric facts", () => {
    const draft = createReportDraft();
    const preview = { revision: 8, snapshot: { nativeEvidence: { disclosure: { copies: [
        { key: "native-prompt", purpose: "prompt" }, { key: "native-context", purpose: "context" },
    ] } } } };
    assert.equal(draft.bindContext(preview), true);
    const token = draft.contextToken();
    assert.equal(draft.contextCurrent(token), true);
    draft.change({ overrides: [{ key: "native-prompt", text: "Keep edited prompt" }, { key: "native-context", text: "Retire stale context" }] });
    assert.equal(draft.observeContext({ revision: 9 }), true);
    assert.equal(draft.contextCurrent(token), false);
    assert.deepEqual(draft.options().overrides, [{ key: "native-prompt", text: "Keep edited prompt" }]);
    assert.equal(draft.bindContext(preview), false);
});

test("qualified native capture advancement keeps prepared copies but never preserves changed disclosure authority", () => {
    const draft = createReportDraft();
    const basis = { sourceRevision: 4, membershipRevision: 4, consentRevision: 1, overrideRevision: 0, deletionEpoch: 0 };
    const preview = { revision: 8, snapshot: { nativeEvidence: { githubEvaluationFacts: { basis },
        disclosure: { copies: [{ key: "kept-context", purpose: "context" }] } } } };
    draft.bindContext(preview);
    const token = draft.contextToken(), operation = draft.token();
    assert.equal(draft.observeContext({ revision: 9, assessment: { basis: { ...basis, sourceRevision: 5, membershipRevision: 5 } } },
        { preserveNativeSource: true }), false);
    assert.equal(draft.contextCurrent(token), true);
    assert.equal(draft.current(operation), true);
    assert.equal(draft.bindContext(preview), true, "A still-authorized original root can finish preparing after collection advances.");
    assert.equal(draft.observeContext({ revision: 10, assessment: { basis: { ...basis, consentRevision: 2 } } },
        { preserveNativeSource: true }), true);
    assert.equal(draft.bindContext(preview), false);
});

test("qualified collected GitHub context keeps reply edits across capture without accepting changed authority", () => {
    const draft = createReportDraft();
    const basis = { sourceRevision: 4, membershipRevision: 4, consentRevision: 1, overrideRevision: 0, deletionEpoch: 0 };
    const preview = { revision: 8, collectedSourceFrozen: true, snapshot: { evaluationFacts: { basis },
        recordedContext: { entries: [{ key: "reply-copy", kind: "response" }] } } };
    draft.bindContext(preview);
    draft.change({ overrides: [{ key: "reply-copy", text: "My reviewed reply edit" }] });
    const token = draft.contextToken(), operation = draft.token();
    assert.equal(draft.observeContext({ revision: 9, assessment: { basis: { ...basis, sourceRevision: 5, membershipRevision: 5 } } },
        { preserveCollectedSource: true }), false);
    assert.equal(draft.contextCurrent(token), true);
    assert.equal(draft.current(operation), true);
    assert.deepEqual(draft.options().overrides, [{ key: "reply-copy", text: "My reviewed reply edit" }]);
    assert.equal(draft.bindContext(preview), true);
    assert.equal(draft.observeContext({ revision: 10, assessment: { basis: { ...basis, consentRevision: 2 } } },
        { preserveCollectedSource: true }), true);
    assert.deepEqual(draft.options().overrides, []);
    assert.equal(draft.bindContext(preview), false);
});

test("a report title belongs to its draft, survives scope refinement and clears with the whole draft", () => {
    const draft = createReportDraft();
    const token = draft.token();
    draft.change({ title: "Weekly planning", formats: ["html", "json"] });
    assert.equal(draft.current(token), false);
    draft.select(["first", "second"]);
    assert.equal(draft.options().title, "Weekly planning");
    draft.clearSelection();
    assert.equal(draft.options().title, undefined);
    assert.deepEqual(draft.options().formats, ["html", "json"]);
});

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

test("catalog timing freshness alone preserves a selected preview, but timing facts still invalidate it", () => {
    const request = { scenarioId: "selected", aliases: ["selected"] };
    const scope = { requests: [request], baseRequests: [request] };
    const state = { revision: 1, scenarios: [{ scenarioId: "selected" }], assessment: { catalog: [{
        scenarioId: "selected", interactionRef: "kept-ref", reviewStatusRevision: "kept-review",
        responseTiming: { sourceRevision: 1, interactionRef: "kept-ref", boundary: "recorded-request-to-final-answer", status: "unavailable", durationMs: null },
    }] } };
    const draft = createReportDraft();
    draft.synchronizeBasis(state, scope);
    const token = draft.token(), refreshed = structuredClone(state);
    refreshed.revision++;
    refreshed.assessment.catalog[0].responseTiming.sourceRevision++;
    assert.equal(draft.synchronizeBasis(refreshed, scope), false);
    assert.equal(draft.current(token), true);
    const changed = structuredClone(refreshed);
    changed.assessment.catalog[0].responseTiming.status = "measured";
    changed.assessment.catalog[0].responseTiming.durationMs = 25;
    assert.equal(draft.synchronizeBasis(changed, scope), true);
    assert.equal(draft.current(token), false);
    assert.equal(state.assessment.catalog[0].responseTiming.sourceRevision, 1, "Fingerprinting does not mutate the accepted snapshot");
    const paired = createReportDraft();
    paired.synchronizeBasis(state, scope, { paired: true });
    assert.equal(paired.synchronizeBasis(refreshed, scope, { paired: true }), true, "Accepted paired cohorts keep their revision-bound authority");
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
