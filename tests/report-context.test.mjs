import test from "node:test";
import assert from "node:assert/strict";
import { proposeReportContext, reportPromptAllowed } from "../lib/report-context.mjs";
import { retainedContextFixture } from "./request-context-fixture.mjs";
import { reportContextFixture } from "./report-context-fixture.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { privateFixture } from "./helpers.mjs";
import { createReportDraft } from "../web/report-draft.mjs";

test("report context uses the reader's exact links without enlarging analytical membership", () => {
    const { records } = retainedContextFixture();
    const selected = [records[1]], before = structuredClone(selected);
    const proposal = proposeReportContext(records, selected, ["user", "agent", "unknown"]);
    assert.deepEqual(proposal.anchors[0].groups.map(group => group.scenario.scenarioId),
        records.slice(0, 3).map(record => record.scenarioId));
    assert.equal(proposal.anchors[0].groups.some(group => group.scenario === records[3]), false);
    assert.deepEqual(selected, before);
    const disconnected = structuredClone(records[0]);
    disconnected.scenarioId = "same-chat-without-link";
    disconnected.followUpPrompts = [];
    disconnected.userPrompt.sourceEventId = "no-link";
    assert.equal(proposeReportContext([...records, disconnected], selected, ["user"]).anchors[0].groups.length, 3);
});

test("bounded copies preserve counts and verdict scopes and mask every contextual field", async t => {
    const { context, records } = await reportContextFixture(t);
    const controller = createExportController(context);
    const state = await loadBoardState(context);
    const selection = { kind: "selected", revision: state.revision, scenarioIds: [records[1].scenarioId], promptAuthors: ["user"] };
    const plain = await controller.preview("context-owner", undefined, { formats: ["json", "markdown"] }, selection);
    const withContext = await controller.preview("context-owner", undefined,
        { formats: ["json", "markdown"], recordedContext: true }, selection);
    assert.deepEqual(withContext.snapshot.selectionScope, plain.snapshot.selectionScope);
    assert.deepEqual(withContext.records, plain.records);
    assert.deepEqual(withContext.snapshot.summary, plain.snapshot.summary);
    const metrics = bundle => bundle.snapshot.evaluationFacts.metrics.map(({ createdAt, ...metric }) => metric);
    assert.deepEqual(metrics(withContext), metrics(plain), "Only preparation timestamps may differ, never metric identities or populations");
    const oldVerdict = state.personalEvaluation.feedback.records[0].assessment;
    assert.equal(withContext.snapshot.evaluationFacts.memberships.some(item => item.interactionRef === oldVerdict.interactionRef), false,
        "The earlier five-document verdict never becomes the changed three-document result's verdict");
    const frozen = withContext.snapshot.recordedContext;
    assert.equal(frozen.schemaVersion, 1);
    assert.match(JSON.stringify(frozen), /Find five synthetic/);
    assert.match(JSON.stringify(frozen), /Three synthetic documents/);
    assert.match(JSON.stringify(frozen), /Here are three synthetic/);
    assert.doesNotMatch(JSON.stringify(frozen), /first@example|reply@example|tenant\.example|UNRELATED_CONTEXT/);
    assert.match(withContext.files["product-report.md"], /Here are three synthetic/);
    assert.equal(withContext.contextReview.some(entry => entry.kind === "response"), true);
    assert.equal(withContext.contextReview.some(entry => Object.hasOwn(entry, "at")), false);
    assert.doesNotMatch(JSON.stringify(frozen), /payloadFile|textRef|deletionKeys|dependencies|sourceConfigRef|sourceEventId/);
});

test("the recorded selector adds no new 500-anchor cap and excludes ineligible source context explicitly", () => {
    const original = retainedContextFixture().records[0];
    const records = Array.from({ length: 501 }, (_, index) => ({ ...original, scenarioId: `group-${index}`,
        sourceSessionId: `chat-${index}`, followUpPrompts: [] }));
    assert.equal(proposeReportContext(records, records, ["user"]).anchors.length, 501);
    const linked = retainedContextFixture().records;
    linked[0].sample = true;
    const proposal = proposeReportContext(linked, [linked[1]], ["user"]);
    assert.equal(proposal.anchors[0].sourceExcludedGroups, 1);
    assert.equal(proposal.anchors[0].groups.some(group => group.scenario === linked[0]), false);
});

test("author exclusions follow the originating group, including duplicated follow-up copies", () => {
    const { records } = retainedContextFixture();
    records[0].userPrompt.authorship = { actor: "agent", basis: "source-agent" };
    const proposal = proposeReportContext(records, [records[1]], ["user"]);
    assert.equal(proposal.anchors[0].authorExcludedGroups, 1);
    assert.equal(proposal.anchors[0].groups.some(group => group.scenario === records[0]), false);
    records[1].userPrompt.authorship = { actor: "agent", basis: "source-agent" };
    records[0].followUpPrompts[0].authorship = { actor: "user", basis: "source-user" };
    assert.equal(reportPromptAllowed(records, records[0], records[0].followUpPrompts[0], ["user"]), false,
        "The linked originating group's author wins over a copied follow-up author");
    assert.equal(reportPromptAllowed(records, records[0], records[0].followUpPrompts[0], ["agent"]), true);
    const unknown = { status: "full", text: "Unattributed retained fragment" };
    assert.equal(reportPromptAllowed(records, records[0], unknown, ["user"]), false);
    const ungrouped = { ...unknown, sourceEventId: "ungrouped", authorship: { actor: "user", basis: "source-user" } };
    assert.equal(reportPromptAllowed(records, records[0], ungrouped, ["user"]), false, "Known sender alone cannot establish the originating group");
    assert.equal(reportPromptAllowed(records, records[0], ungrouped, ["user", "unknown"]), true);
});

test("excluded neighboring originating group cannot leak through the selected group's old follow-up copy", async t => {
    const { records } = retainedContextFixture();
    records[1].userPrompt.authorship = { actor: "agent", basis: "source-agent" };
    records[1].userPrompt.text = "EXCLUDED_NEIGHBOR_CANARY";
    records[0].followUpPrompts[0].text = "EXCLUDED_NEIGHBOR_CANARY";
    records[0].followUpPrompts[0].authorship = { actor: "user", basis: "source-user" };
    for (const record of records) for (const call of record.toolCalls) call.requestArgs = { entityUrls: ["/me/drive/root/children"] };
    const { context } = await privateFixture(t, records);
    const state = await loadBoardState(context), controller = createExportController(context);
    const preview = await controller.preview("author-owner", undefined, { formats: ["json"] },
        { kind: "selected", revision: state.revision, scenarioIds: [records[0].scenarioId], promptAuthors: ["user"] });
    assert.doesNotMatch(JSON.stringify(preview), /EXCLUDED_NEIGHBOR_CANARY/);
    assert.match(JSON.stringify(preview.records), /excluded.*author/i);
});

test("multiple selected anchors share one edit key for the same recorded message and keep per-anchor relations", async t => {
    const { context, records } = await reportContextFixture(t), controller = createExportController(context);
    const state = await loadBoardState(context), selection = { kind: "selected", revision: state.revision,
        scenarioIds: records.map(record => record.scenarioId), promptAuthors: ["user"] };
    const preview = await controller.preview("anchors", undefined, { recordedContext: true, formats: ["json"] }, selection);
    const copies = [...preview.promptReview, ...preview.contextReview].filter(copy => copy.original === records[1].userPrompt.text);
    assert.equal(copies.length, 1, "The retained correction has one review and edit key across anchors and the prompt appendix");
    const contextEntries = preview.snapshot.recordedContext;
    assert.equal(contextEntries.anchors.length, 2);
    assert.deepEqual(contextEntries.anchors.map(anchor => anchor.groups.map(group => group.relation)),
        [["selected", "following"], ["preceding", "selected"]]);
    const rebuilt = await controller.preview("anchors", undefined, { recordedContext: true, formats: ["json"],
        overrides: [{ key: copies[0].key, text: "One edited correction" }] }, selection);
    assert.equal(rebuilt.records.flatMap(record => record.prompts).filter(copy => copy.key === copies[0].key)
        .every(copy => copy.text === "One edited correction"), true);
    assert.equal(rebuilt.snapshot.recordedContext.entries.filter(copy => copy.key === copies[0].key).length, 1);
    assert.equal(rebuilt.snapshot.selectionScope.requestGroups, 2);
});

test("leaving out linked text preserves selected shared-message edits through real report projection", async t => {
    const { context, records } = await reportContextFixture(t), controller = createExportController(context);
    const state = await loadBoardState(context), selection = { kind: "selected", revision: state.revision,
        scenarioIds: records.map(record => record.scenarioId), promptAuthors: ["user"] };
    const draft = createReportDraft();
    draft.change({ recordedContext: true, formats: ["json"] });
    const preview = await controller.preview("privacy-switch", undefined, draft.options(), selection);
    assert.equal(draft.bindContext(preview), true);
    const shared = preview.promptReview.find(copy => copy.original === records[1].userPrompt.text);
    assert.ok(shared);
    draft.change({ overrides: [{ key: shared.key, text: "Kept correction" }] });
    draft.changePromptMode("none");
    const omitted = await controller.preview("privacy-switch", undefined, draft.options(), selection);
    assert.ok(omitted.records.every(record => record.prompts.every(copy => copy.text === null)));
    assert.equal(omitted.snapshot.recordedContext, undefined);
    assert.equal(draft.bindContext(omitted), true);
    draft.changePromptMode("masked");
    const restored = await controller.preview("privacy-switch", undefined, draft.options(), selection);
    assert.equal(restored.records.flatMap(record => record.prompts).filter(copy => copy.text === "Kept correction").length, 2);
    assert.deepEqual(restored.snapshot.selectionScope, preview.snapshot.selectionScope);
});

test("unsupported message identity and missing time remain gaps rather than invented source references", async t => {
    const { context, records } = await reportContextFixture(t);
    const before = await loadBoardState(context);
    await replaceEvidence(context, () => ({ records: before.evidence.map(record => record.scenarioId === records[1].scenarioId
        ? { ...record, userPrompt: { ...record.userPrompt, sourceEventId: 17, sourceTimestamp: null } } : record), importCoverage: {} }));
    const state = await loadBoardState(context);
    const preview = await createExportController(context).preview("missing-identity", undefined, { recordedContext: true, formats: ["json"] },
        { kind: "selected", revision: state.revision, scenarioIds: [records[1].scenarioId], promptAuthors: ["user"] });
    const prompt = preview.snapshot.recordedContext.entries.find(entry => entry.kind === "prompt");
    assert.equal(prompt.eventRef, null);
    assert.equal(prompt.timeStatus, "unknown");
    assert.match(preview.snapshot.recordedContext.anchors[0].gaps.join(" "), /message identity was not retained/);
});
