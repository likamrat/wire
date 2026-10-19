import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, unlink, readdir } from "node:fs/promises";
import path from "node:path";
import { createSearchCorpus } from "../lib/search-corpus.mjs";
import { corpusHash, corpusId, reportDocumentText } from "../lib/search-corpus-content.mjs";
import { createCorpusSources, createSavedCorpusEntry, projectSavedSearchTitle } from "../lib/search-corpus-sources.mjs";
import { indexSearchText, rankTextSearch, textSearchHit } from "../lib/search-text.mjs";
import { searchHitPresentation } from "../web/live-search.mjs";
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
import { createSavedArtifactDescriptor, readSavedReportFile, readSavedComparison } from "../lib/report-artifacts.mjs";
import { extractReportFile } from "../lib/search-corpus-report-content.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";

test("verified saved-title carrier is format-independent and preserves exact masked metadata", () => {
    const canonicalTitle = "Release review \u2014 " + "[masked contact] ".repeat(30);
    assert.ok(canonicalTitle.length > 200);
    for (const format of ["html", "json", "markdown", "pdf", "comparison"]) {
        assert.equal(projectSavedSearchTitle({ format, canonicalTitle }, "A different extracted title"), canonicalTitle);
    }
    for (const extracted of [undefined, "", "Saved report", "Saved comparison", "A genuine legacy title"]) {
        assert.equal(projectSavedSearchTitle({ artifact: { title: "Index-only title" } }, extracted), extracted);
        assert.equal(projectSavedSearchTitle({ snapshot: { title: "Not the agreed carrier" } }, extracted), extracted);
    }
    for (const canonicalTitle of [undefined, null, "", "  ", 42, "Title\nextra", "Title\u0085extra"]) {
        assert.throws(() => projectSavedSearchTitle({ canonicalTitle }, "Legacy title"),
            error => error.code === "invalid-canonical-title");
    }
});

test("verified canonical title survives saved-entry construction, literal lookup and original ranges", async () => {
    const identifier = "build-" + "a".repeat(32);
    for (const kind of ["report", "comparison"]) for (const format of ["html", "json", "markdown", "pdf"]) {
        for (const canonicalTitle of ["Review " + identifier, "[masked contact] ".repeat(20) + "Review \u{1f680} e\u0301 " + identifier]) {
            const artifact = { bundleId: "export-00000000-0000-4000-8000-000000000001",
                kind, manifestHash: "b".repeat(64), promptMode: "original", title: "Index-only title" };
            const document = { artifact, format, sha256: "c".repeat(64), canonicalTitle };
            const extracted = { title: canonicalTitle, content: "Body " + identifier, coverage: { format } };
            const sourceRevision = "d".repeat(64);
            const saved = createSavedCorpusEntry(artifact, document, extracted, sourceRevision);
            assert.equal(saved.title, canonicalTitle, "The production entry builder must keep the verified declaration.");
            assert.equal(saved.content, "Body [private value removed]", "Canonical title authority does not exempt body content.");
            const matches = await rankTextSearch([indexSearchText(saved)], identifier.toUpperCase(), [kind], new AbortController().signal);
            assert.equal(matches.length, 1);
            const hit = textSearchHit(saved, matches[0]), range = hit.textMatch;
            assert.equal(hit.title, canonicalTitle);
            assert.equal(range.field, "title");
            assert.equal(range.start, canonicalTitle.indexOf(identifier));
            assert.equal(range.end, canonicalTitle.length);
            assert.equal(hit.excerpt.slice(range.start - range.excerptStart, range.end - range.excerptStart), identifier);
            const shown = searchHitPresentation(hit, { showSource: false });
            assert.equal(shown.title.map(part => part.text).join(""), canonicalTitle);
            assert.equal(shown.title.find(part => part.match).text, identifier);
            const { revision, ...fields } = saved;
            assert.equal(revision, corpusHash(fields));
            assert.equal(Object.hasOwn(saved, "hasCanonicalTitle"), false, "The internal authority flag is not a new wire field.");

            const legacyDocument = { ...document };
            delete legacyDocument.canonicalTitle;
            const legacy = createSavedCorpusEntry(artifact, legacyDocument, extracted, sourceRevision);
            assert.equal(legacy.title, canonicalTitle.replace(identifier, "[private value removed]"),
                "An equal extracted title without the real carrier retains privacy screening.");
            assert.equal(legacy.id, saved.id);
            assert.notEqual(legacy.revision, saved.revision, "Canonical title text participates in corpus identity.");
            assert.deepEqual(await rankTextSearch([indexSearchText(legacy)], identifier, [kind], new AbortController().signal), []);
            assert.throws(() => createSavedCorpusEntry(artifact, { ...document, canonicalTitle: null }, extracted, sourceRevision),
                error => error.code === "invalid-canonical-title");
        }
    }
});

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

test("real report producers preserve verified titles through every Search format and reject mismatched identity", async t => {
    const records = [fixture("title-source-a"), fixture("title-source-b")];
    const { context } = await privateFixture(t, records), controller = createExportController(context);
    const formats = ["html", "json", "markdown", "pdf"], saved = [], ordinary = [];
    const titleInput = "Zebra " + Array(8).fill("a@example.invalid").join(" ");
    assert.ok(titleInput.length <= 200);
    for (const format of formats) {
        const state = await loadBoardState(context);
        const preview = await controller.preview("title-search", undefined, {
            title: titleInput, promptMode: "none", formats: [format],
        }, { kind: "all", revision: state.revision });
        assert.ok(preview.title.length > 200, "Metadata masking can expand a valid title input");
        await controller.review("title-search", preview.previewId, true);
        const bundle = (await controller.confirm("title-search", preview.previewId, true)).bundle;
        ordinary.push(bundle); saved.push({ bundle, format, title: preview.title, kind: "report" });
    }
    for (const format of formats) {
        const preview = await controller.previewComparison("title-search", ordinary[0].bundleId, ordinary[1].bundleId, {
            title: "Zebra comparison", formats: [format],
        });
        await controller.reviewComparison("title-search", preview.previewId, true);
        const bundle = (await controller.confirmComparison("title-search", preview.previewId, true)).bundle;
        saved.push({ bundle, format, title: preview.title, kind: "comparison" });
    }
    const before = await loadBoardState(context), stateBytes = JSON.stringify(before);
    const fileBytes = await Promise.all(saved.flatMap(({ bundle }) => Object.values(bundle.files)).map(async file => [file, await readFile(file)]));
    const sources = createCorpusSources(context, { source: inventedSource }), frame = await sources.scan();
    const artifacts = frame.entries.filter(entry => ["report", "comparison"].includes(entry.type));
    assert.equal(artifacts.length, saved.length, JSON.stringify(frame.issues));
    for (const expected of saved) {
        const document = expected.kind === "report"
            ? await readSavedReportFile(context, before, expected.bundle.bundleId, expected.format)
            : await readSavedComparison(context, before, expected.bundle.bundleId);
        assert.equal(document.canonicalTitle, expected.title);
        const entry = artifacts.find(item => item.target.bundleId === expected.bundle.bundleId);
        assert.equal(entry.title, expected.title);
        assert.equal(entry.type, expected.kind);
        if (expected.kind === "report") assert.equal(entry.coverage.format, expected.format);
    }
    const matches = await rankTextSearch(artifacts.map(indexSearchText), "zebra", ["report", "comparison"], new AbortController().signal);
    assert.equal(matches.length, saved.length);
    for (const match of matches) {
        const entry = artifacts.find(item => item.id === match.id), hit = textSearchHit(entry, match);
        assert.equal(hit.title, entry.title);
        assert.equal(hit.textMatch.field, "title");
        assert.equal(hit.title.slice(hit.textMatch.start, hit.textMatch.end), "Zebra");
    }
    assert.equal(JSON.stringify(await loadBoardState(context)), stateBytes);
    for (const [file, bytes] of fileBytes) assert.deepEqual(await readFile(file), bytes);

    const changed = [saved[0], saved[4]];
    await updateBoardState(context, state => {
        for (const item of changed) state.exports.find(entry => entry.bundleId === item.bundle.bundleId).title = "Wrong indexed label";
    });
    const mismatched = await sources.scan();
    for (const item of changed) assert.equal(mismatched.entries.some(entry => entry.target.bundleId === item.bundle.bundleId), false);
    assert.equal(mismatched.issues.filter(issue => ["report", "comparison"].some(type => issue.types.includes(type))).length, changed.length);

    for (const item of changed) {
        const manifestFile = item.bundle.files["coverage-and-redaction-manifest.json"];
        const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
        delete manifest.title;
        const metadata = JSON.stringify(manifest);
        await writeFile(manifestFile, metadata);
        await updateBoardState(context, state => {
            const entry = state.exports.find(value => value.bundleId === item.bundle.bundleId);
            entry.manifestHash = corpusHash(metadata);
            entry.title = "Index-only fallback, not a canonical title";
        });
    }
    const legacyState = await loadBoardState(context), legacy = await sources.scan();
    for (const item of changed) {
        const document = item.kind === "report"
            ? await readSavedReportFile(context, legacyState, item.bundle.bundleId, item.format)
            : await readSavedComparison(context, legacyState, item.bundle.bundleId);
        assert.equal(Object.hasOwn(document, "canonicalTitle"), false);
        const entry = legacy.entries.find(value => value.target.bundleId === item.bundle.bundleId);
        assert.ok(entry, JSON.stringify(legacy.issues));
        assert.notEqual(entry.title, "Index-only fallback, not a canonical title");
        assert.equal(entry.title, item.kind === "report" ? (await extractReportFile(document)).title : "Saved comparison");
    }
});

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
    records[1].followUpPrompts.push({ status: "partial", text: "Historical note: Sidebar motion was discussed.",
        sourceEventId: "historical-motion-note", sourceTimestamp: "2026-09-30T12:00:10Z" });
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
    assert.ok(items.some(item => item.type === "context" && item.content === "Historical note: Sidebar motion was discussed."),
        "Retiring a setting does not erase historical saved text");
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
    assert.equal(settingsItems.length, 19);
    assert.ok(settingsItems.every(item => !item.target.href.includes("sidebar-motion")));
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
        && item.target.href === "#analyze"));
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
