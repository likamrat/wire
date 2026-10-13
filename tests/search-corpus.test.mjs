import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, unlink, readdir } from "node:fs/promises";
import path from "node:path";
import { createSearchCorpus } from "../lib/search-corpus.mjs";
import { corpusHash, corpusId, reportDocumentText } from "../lib/search-corpus-content.mjs";
import { createCorpusSources } from "../lib/search-corpus-sources.mjs";
import { createSettingsNavigation } from "../web/settings-navigation.mjs";
import { createCallInvestigation } from "../web/call-investigation.mjs";
import { buildRequestActivity } from "../lib/activity-analytics.mjs";
import { privateFixture, fixture } from "./helpers.mjs";
import { retainedContextFixture } from "./request-context-fixture.mjs";
import { callInvestigationRecords } from "./call-investigation-fixture.mjs";
import { inventedSource, seedRetainedReply } from "./search-corpus-fixture.mjs";
import { loadBoardState, updateBoardState, replaceEvidence } from "../lib/store.mjs";
import { createExportController } from "../lib/export.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { executeAssessmentAction } from "../lib/assessment.mjs";
import { selectPersonalEvaluationCleanup } from "../lib/personal-evaluation.mjs";
import { finalizePersonalEvaluationCleanup } from "../lib/assessment-read-model.mjs";
import { createSavedArtifactDescriptor } from "../lib/report-artifacts.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";

async function savedReport(session, controller, promptMode) {
    const state = await loadBoardState(session);
    const preview = await controller.preview("corpus-fixture", undefined, { promptMode, formats: ["html", "json"] },
        { kind: "all", revision: state.revision });
    await controller.review("corpus-fixture", preview.previewId, true);
    return (await controller.confirm("corpus-fixture", preview.previewId, true)).bundle;
}
async function indexed(corpus) {
    let items, receipt;
    const status = await corpus.index(entries => entries, (value, token) => { items = value; receipt = token; });
    assert.ok(items, JSON.stringify(status));
    return { items, ticket: { ...receipt, hits: items.map(({ id, revision }) => ({ id, revision })) }, status };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("inert body extraction keeps escaped text, never scripts, attributes, comments, SVG or fonts", () => {
    const html = `<!doctype html><html><head><style>@font-face { src: url(SECRET_FONT) }</style></head><body>
        <p>Visible &lt;script&gt;escaped&lt;/script&gt; &amp; &#65;</p><!--SECRET_COMMENT-->
        <script>SECRET_SCRIPT < p</script><svg><path d="SECRET_VECTOR"/><text>SECRET_SVG</text></svg>
        <p hidden>SECRET_HIDDEN</p><p aria-hidden="true">SECRET_ARIA</p><div style="display:none">SECRET_STYLE</div>
        <template><p>SECRET_TEMPLATE</p></template><img src="https://outside.invalid/SECRET_IMAGE">
        <a href="https://outside.invalid/SECRET_LINK">Permitted link label</a>
        <p title="A hidden word is not an attribute">Visible attribute example</p>
        <p>token=ghp_123456789012345678901234567890</p><p>C:\\private\\source.db</p>
        <p>observation-${"a".repeat(32)}</p></body></html>`;
    const text = reportDocumentText(html);
    assert.match(text, /Visible <script>escaped<\/script> & A/);
    assert.match(text, /Permitted link label/);
    assert.match(text, /Visible attribute example/);
    assert.doesNotMatch(text, /SECRET_|ghp_|C:\\|outside\.invalid|observation-/);
    assert.throws(() => reportDocumentText("<html><body><p>broken</body></html>"));
    assert.throws(() => reportDocumentText("<html><body><script/>HIDDEN_SCRIPT</body></html>"));
});

test("real retained readers yield all corpus types, canonical targets and immutable reviewed artifact content", async t => {
    const { records } = retainedContextFixture();
    records[0].userPrompt.authorship = { actor: "unknown", basis: "missing-source" };
    records[0].userPrompt.status = "partial";
    records[0].userPrompt.text += " email@example.invalid";
    for (const record of records) for (const call of record.toolCalls) {
        call.requestArgs = { entityUrls: ["/me/drive/root/children"] };
        call.apiResults = [{ index: 0, statusCode: 200, evidenceLevel: "intermediary-reported" }];
    }
    records[1].followUpPrompts.push({ status: "partial", text: "INVENTED_FOLLOWUP_CONTEXT",
        sourceEventId: "extra-followup", sourceTimestamp: "2026-09-30T12:00:09Z" });
    records[1].followUpPrompts.push({ status: "unavailable", text: "HIDDEN_NOT_RETAINED" });
    const { context } = await privateFixture(t, records);
    await seedRetainedReply(context);
    const exports = createExportController(context);
    const original = await savedReport(context, exports, "original"), masked = await savedReport(context, exports, "masked");
    const none = await savedReport(context, exports, "none");
    const preview = await exports.previewComparison("corpus-fixture", original.bundleId, none.bundleId, { formats: ["json"] });
    await exports.reviewComparison("corpus-fixture", preview.previewId, true);
    const comparison = (await exports.confirmComparison("corpus-fixture", preview.previewId, true)).bundle;
    let invalidations = 0;
    const corpus = createSearchCorpus(context, { source: inventedSource, onInvalidate: () => { invalidations++; } });
    assert.equal(corpus.status().state, "uninitialized");
    const { items, ticket } = await indexed(corpus);
    const comparisonView = items.find(item => item.id === corpusId("view", "compare-periods"));
    assert.deepEqual(comparisonView.target, { kind: "route", href: "#analyze?compare=periods" });
    assert.equal(comparisonView.source.kind, "fixed-navigation");
    assert.deepEqual(new Set(items.map(item => item.type)), new Set(["interaction", "context", "reply", "action", "tool", "service", "report", "comparison", "view", "setting"]));
    const origin = items.find(item => item.id === corpusId("interaction", `prompt:${records[0].scenarioId}`));
    assert.equal(origin.coverage.author, "unknown"); assert.equal(origin.coverage.completeness, "partial");
    assert.equal(origin.contentHash, corpusHash(origin.content));
    assert.ok(origin.coverage.linkedInteractions.length <= 3);
    assert.ok(items.some(item => item.type === "context" && item.content === "INVENTED_FOLLOWUP_CONTEXT"));
    const reply = items.find(item => item.type === "reply");
    assert.match(reply.content, /INVENTED_RETAINED_REPLY/); assert.equal(reply.coverage.finality, "unverified");
    assert.ok(items.some(item => item.type === "action" && item.content.includes("workiq-sign-in-required")));
    const reports = [original, masked, none].map(bundle => items.find(item => item.target.bundleId === bundle.bundleId));
    assert.deepEqual(reports.map(item => item.coverage.textMode), ["original", "masked", "none"]);
    assert.match(reports[0].content, /email@example\.invalid/);
    assert.doesNotMatch(reports[1].content, /email@example\.invalid/);
    assert.doesNotMatch(reports[2].content, /Find five synthetic documents/);
    assert.match(reports[0].content, /Find five synthetic documents/);
    const frozenComparison = items.find(item => item.target.bundleId === comparison.bundleId);
    assert.match(frozenComparison.content, /metric|recorded|status/);
    assert.equal(frozenComparison.target.kind, "open-saved-comparison");
    assert.match(frozenComparison.target.manifestHash, /^[a-f0-9]{64}$/);
    assert.match(frozenComparison.target.documentHash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(items).match(/HIDDEN_NOT_RETAINED|payloadFile|receiptToken|sourceConfigRef|bundleDir|C:\\\\/g)?.join(",") ?? null, null);
    const settings = createSettingsNavigation(), settingsItems = items.filter(item => item.type === "setting");
    assert.equal(settingsItems.length, 20);
    for (const item of settingsItems) {
        const [view, query] = item.target.href.slice(1).split("?"), parameters = Object.fromEntries(new URLSearchParams(query));
        const resolved = settings.resolve(parameters);
        assert.equal(view, resolved.view ?? "settings");
        assert.equal(parameters.setting, resolved.setting);
    }
    const activity = buildRequestActivity(records), revision = (await loadBoardState(context)).revision;
    for (const item of items.filter(item => item.type === "action")) {
        const query = Object.fromEntries(new URLSearchParams(item.target.href.split("?")[1]));
        assert.equal(createCallInvestigation().resolve(activity, records, query, revision).status, "available");
        if (query.layer === "reported-api") assert.equal(query.callRevision, String(revision));
    }
    let delivered;
    await corpus.deliver(ticket, value => { delivered = value; });
    assert.equal(delivered.length, items.length);
    const second = await indexed(corpus);
    assert.deepEqual(second.items, items); assert.equal(invalidations, 1);
    assert.ok(Object.isFrozen(items[0].target));
});

test("revocation during queued indexing rejects late publication while frozen report survives", async t => {
    const { context } = await privateFixture(t);
    await seedRetainedReply(context);
    const exports = createExportController(context), saved = await savedReport(context, exports, "original");
    let derived = null;
    const corpus = createSearchCorpus(context, { source: inventedSource, onInvalidate: () => { derived = null; } });
    const first = await indexed(corpus), reportBefore = first.items.find(item => item.target.bundleId === saved.bundleId);
    derived = first.ticket;
    const entered = deferred(), release = deferred();
    const pending = corpus.index(async entries => { entered.resolve(); await release.promise; return entries; }, () => { derived = "LATE"; });
    await entered.promise;
    const deletion = createDeletionController(context, {
        selectPersonalEvaluationCleanup, finalizePersonalEvaluationCleanup, onSeal: () => corpus.invalidate(),
    });
    const state = await loadBoardState(context);
    await executeAssessmentAction(context, "corpus-fixture", "set_assessment_consent", {
        schemaVersion: 1, mutationRef: `mutation-${"9".repeat(32)}`, expectedSourceRevision: state.evidenceRevision,
        expectedConsentRevision: 1, policyVersion: 1, enabled: false, categories: [],
        sourceConfigRef: inventedSource().sourceConfigRef, sourceConfigRevision: 1, confirmed: true,
    }, { source: inventedSource, commitCaptureRevocation: deletion.commitCaptureRevocation });
    release.resolve();
    assert.equal((await pending).state, "superseded"); assert.equal(derived, null);
    let disclosed = false;
    await corpus.deliver(first.ticket, () => { disclosed = true; });
    assert.equal(disclosed, false);
    const after = await indexed(corpus);
    assert.equal(after.items.some(item => item.type === "reply"), false);
    assert.deepEqual(after.items.find(item => item.target.bundleId === saved.bundleId), reportBefore);
    assert.ok(after.status.issues.some(item => item.code === "revoked"));
});

test("current source replacement, payload removal and corrupt input fail closed without fallback or stale delivery", async t => {
    const { context } = await privateFixture(t);
    const reply = await seedRetainedReply(context);
    let source = inventedSource();
    const corpus = createSearchCorpus(context, { source: () => source, onInvalidate: () => {} });
    const initial = await indexed(corpus);
    source = { ...source, sourceConfigRevision: 2 };
    let disclosed = false;
    await corpus.deliver(initial.ticket, () => { disclosed = true; });
    assert.equal(disclosed, false);
    assert.equal((await indexed(corpus)).items.some(item => item.type === "reply"), false);
    source = inventedSource();
    await unlink(reply.payloadFile);
    const missing = await indexed(corpus);
    assert.equal(missing.items.some(item => item.type === "reply"), false);
    assert.ok(missing.status.issues.some(item => item.code === "missing"));
    await writeFile(reply.payloadFile, "CORRUPT_PRIVATE_PAYLOAD");
    assert.ok((await indexed(corpus)).status.issues.some(item => /integrity|corrupt/.test(item.code)));
    source = undefined;
    const failed = await corpus.rebuild();
    assert.equal(failed.state, "unavailable"); assert.equal(failed.items, 0);
    assert.match(failed.issues[0].code, /source/);
    assert.doesNotMatch(JSON.stringify(failed), /CORRUPT_PRIVATE_PAYLOAD|C:\\/);
});

test("artifact and retained-activity deletion invalidate their own content; restart cannot expose old tickets", async t => {
    const { context } = await privateFixture(t);
    const exports = createExportController(context), saved = await savedReport(context, exports, "original");
    const corpus = createSearchCorpus(context, { source: inventedSource, onInvalidate: () => {} });
    const initial = await indexed(corpus);
    const deletion = createDeletionController(context, { describeSavedArtifact: createSavedArtifactDescriptor(context), onSeal: () => corpus.invalidate() });
    const preview = await deletion.previewArtifact("corpus-fixture", { artifactKind: "report", artifactId: saved.bundleId });
    await deletion.confirmArtifact("corpus-fixture", { operationId: preview.operationId, confirmed: true });
    const current = await indexed(corpus);
    assert.equal(current.items.some(item => item.type === "report"), false);
    assert.ok(current.items.some(item => item.type === "interaction"));
    const activityPreview = await deletion.preview("corpus-fixture", { scope: "all", timeContext: { timeZone: "UTC", locale: "en-US" } });
    await deletion.confirm("corpus-fixture", { operationId: activityPreview.operationId, confirmed: true });
    assert.equal((await indexed(corpus)).items.some(item => ["interaction", "context", "action"].includes(item.type)), false);
    corpus.close();
    const restarted = createSearchCorpus(context, { source: inventedSource, onInvalidate: () => {} });
    assert.equal(restarted.status().items, 0); assert.equal(restarted.status().state, "uninitialized");
    let disclosed = false;
    await restarted.deliver(initial.ticket, () => { disclosed = true; });
    assert.equal(disclosed, false);
    assert.equal((await readdir(context.dataDir)).some(name => /search|corpus|index/.test(name)), false);
});

test("registered integrity checks exclude modified artifacts and unregistered neighbors without reconstructing text", async t => {
    const { context } = await privateFixture(t), exports = createExportController(context);
    const saved = await savedReport(context, exports, "original");
    await writeFile(path.join(path.dirname(saved.files["product-report.html"]), "unregistered.html"), "<html><body>UNREGISTERED_SECRET</body></html>");
    const corpus = createSearchCorpus(context, { source: inventedSource, onInvalidate: () => {} });
    const initial = await indexed(corpus);
    const sources = createCorpusSources(context, { source: inventedSource }), frame = await sources.scan();
    const bytes = await readFile(saved.files["product-report.html"], "utf8");
    await writeFile(saved.files["product-report.html"], bytes.replace("</body>", "<p>MODIFIED_SECRET</p></body>"));
    await assert.rejects(sources.current(frame, () => { assert.fail("Changed frozen bytes cannot reach publication"); }), /changed/);
    let disclosed = false;
    await corpus.deliver(initial.ticket, () => { disclosed = true; });
    assert.equal(disclosed, false);
    const current = await indexed(corpus);
    assert.ok(current.status.issues.some(item => item.code === "stale-or-integrity"));
    assert.doesNotMatch(JSON.stringify(current.items), /MODIFIED_SECRET|UNREGISTERED_SECRET/);
    assert.equal(current.items.some(item => item.type === "report"), false);
    const outside = path.join(context.dataDir, "outside.html");
    await writeFile(outside, "<html><body>OUTSIDE_MANAGED_BUNDLE</body></html>");
    await updateBoardState(context, state => { state.exports[0].files["product-report.html"] = outside; });
    const unowned = await indexed(corpus);
    assert.ok(unowned.status.issues.some(item => item.code === "corrupt-or-unsupported"));
    assert.equal(unowned.items.some(item => item.type === "report"), false);
});

test("queued construction and final publication guards reject source changes; missing stores are not initialized", async t => {
    const { context, root } = await privateFixture(t);
    const sources = createCorpusSources(context, { source: inventedSource });
    const frame = await sources.scan();
    await replaceEvidence(context, () => ({ records: [fixture("replacement")], importCoverage: {} }));
    let published = false;
    await assert.rejects(sources.current(frame, () => { published = true; }), /stale/);
    assert.equal(published, false);
    const missing = createSearchCorpus({ dataDir: path.join(root, "never-created") }, { source: inventedSource, onInvalidate: () => {} });
    assert.equal((await missing.rebuild()).state, "unavailable");
    await assert.rejects(readdir(path.join(root, "never-created")), { code: "ENOENT" });
    await updateBoardState(context, state => { state.deletion = { schemaVersion: 1, identities: [], events: [], contextCalls: [],
        pending: "invented", operations: { invented: { kind: "activity-deletion" } } }; });
    const pending = createSearchCorpus(context, { source: inventedSource, onInvalidate: () => {} });
    assert.equal((await pending.rebuild()).state, "unavailable");
    assert.equal(pending.status().issues[0].code, "cleanup-pending");
});

test("an in-flight ID-ticket delivery is cancelled, and JSON-only artifacts remain searchable", async t => {
    const { context } = await privateFixture(t), exports = createExportController(context);
    const corpus = createSearchCorpus(context, { source: inventedSource, onInvalidate: () => {} });
    const first = await indexed(corpus);
    let disclosed = false;
    const delivery = corpus.deliver(first.ticket, () => { disclosed = true; });
    corpus.invalidate();
    assert.equal((await delivery).state, "superseded");
    assert.equal(disclosed, false);
    const state = await loadBoardState(context);
    const preview = await exports.preview("corpus-fixture", undefined, { promptMode: "none", formats: ["json"] },
        { kind: "all", revision: state.revision });
    await exports.review("corpus-fixture", preview.previewId, true);
    const saved = (await exports.confirm("corpus-fixture", preview.previewId, true)).bundle;
    const result = await indexed(corpus);
    const report = result.items.find(item => item.target.bundleId === saved.bundleId);
    assert.equal(report.target.kind, "open-saved-report-file");
    assert.equal(report.target.format, "json");
    assert.ok(report.content.length > 0);
});

test("full retained roster includes undated and earlier interactions, with no private metadata or fabricated targets", async t => {
    const records = [fixture("undated"), { ...fixture("earlier"), isLegacy: true }];
    records[0].sourceSessionName = "C:\\private\\source.db";
    records[0].userPrompt.text = "Retained literal with token=ghp_123456789012345678901234567890";
    records[0].receiptToken = "UNSEARCHABLE_RECEIPT";
    records[0].toolCalls[0].requestArgs.query = "UNSEARCHABLE_TOOL_QUERY";
    records[1].userPrompt = { status: "unavailable", text: "UNSEARCHABLE_HIDDEN" };
    const { context } = await privateFixture(t, records);
    const corpus = createSearchCorpus(context, { source: inventedSource, onInvalidate: () => {} });
    const { items } = await indexed(corpus);
    assert.equal(items.filter(item => item.type === "interaction").length, 2);
    assert.equal(items.find(item => item.id === corpusId("interaction", "prompt:earlier")).coverage.completeness, "unavailable");
    assert.ok(items.some(item => item.type === "action" && item.target.href.includes("request=earlier")));
    assert.equal(JSON.stringify(items).match(/UNSEARCHABLE_|ghp_|C:\\\\/g)?.join(",") ?? null, null);
    assert.ok(items.filter(item => item.type === "view").some(item => item.target.focus === "activityView"
        && item.target.href === "#analyze?mode=calls"));
});

test("frozen comparison identity survives deletion of an original source report", async t => {
    const { context } = await privateFixture(t), exports = createExportController(context);
    const first = await savedReport(context, exports, "original"), second = await savedReport(context, exports, "none");
    const preview = await exports.previewComparison("corpus-fixture", first.bundleId, second.bundleId, { formats: ["json"] });
    await exports.reviewComparison("corpus-fixture", preview.previewId, true);
    const saved = (await exports.confirmComparison("corpus-fixture", preview.previewId, true)).bundle;
    const corpus = createSearchCorpus(context, { source: inventedSource, onInvalidate: () => {} });
    const before = (await indexed(corpus)).items.find(item => item.target.bundleId === saved.bundleId);
    const deletion = createDeletionController(context, { describeSavedArtifact: createSavedArtifactDescriptor(context), onSeal: () => corpus.invalidate() });
    const removal = await deletion.previewArtifact("corpus-fixture", { artifactKind: "report", artifactId: first.bundleId });
    await deletion.confirmArtifact("corpus-fixture", { operationId: removal.operationId, confirmed: true });
    const after = (await indexed(corpus)).items.find(item => item.target.bundleId === saved.bundleId);
    assert.deepEqual(after, before);
});

test("every supported action layer and cross-layer tool/service destination resolves real retained rows", async t => {
    const records = callInvestigationRecords(), { context } = await privateFixture(t, records);
    const corpus = createSearchCorpus(context, { source: inventedSource, onInvalidate: () => {} });
    const { items } = await indexed(corpus), activity = buildRequestActivity(records);
    const revision = (await loadBoardState(context)).revision;
    const actions = items.filter(item => item.type === "action");
    assert.deepEqual(new Set(actions.map(item => item.coverage.layer)), new Set(Object.keys(activity)));
    for (const item of actions) {
        const query = Object.fromEntries(new URLSearchParams(item.target.href.split("?")[1]));
        assert.equal(createCallInvestigation().resolve(activity, records, query, revision).status, "available");
    }
    for (const item of items.filter(item => ["tool", "service"].includes(item.type))) {
        const query = Object.fromEntries(new URLSearchParams(item.target.href.split("?")[1]));
        const rows = buildActivityAnalytics(records, { layer: query.layer,
            filters: { scope: "all", includeMetadata: query.layer === "http", ...(query.tool ? { tools: [query.tool] } : { services: [query.services] }) } }).rows;
        assert.ok(rows.length > 0, `${item.type} ${item.title} must open an actual supported retained slice`);
    }
});
