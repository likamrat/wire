import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createSearchRetrieval } from "../lib/search-retrieval.mjs";
import { createSearchModel } from "../lib/search-model.mjs";
import { SEARCH_TYPES, lexicalMatch, rankSearch } from "../lib/search-ranking.mjs";
import { permittedSearchText } from "../lib/search-chunks.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture } from "./helpers.mjs";
import { inventedSource, seedRetainedReply } from "./search-corpus-fixture.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { createSavedArtifactDescriptor } from "../lib/report-artifacts.mjs";

function records() {
    return [
        ["clinical", "The physician treated an injured patient in the hospital."],
        ["vehicle", "The mechanic repaired a broken automobile in the garage."],
        ["access", "Employees cannot sign in because their credentials have expired."],
        ["unicode", "Café résumé 中文检索 😀"],
        ["tail", "Invented ordinary administrative material. ".repeat(160) + "\nAn astronaut piloted the spacecraft into lunar orbit."],
    ].map(([id, text]) => {
        const record = fixture(id);
        record.userPrompt.text = text;
        record.followUpPrompts = [{ status: "full", text: "Arrange a subsequent medical appointment.", provenance: "human-authored" }];
        record.httpRecords = [{ recordId: `http-${id}`, classification: "direct-graph-http", synthetic: false,
            observedGraphHttp: true, responseOrigin: "https://graph.microsoft.com",
            method: "GET", apiVersion: "v1.0", responsePath: { path: "/me/calendarView", query: [] },
            startedAt: record.capturedAt, durationMs: 12, status: 403, transportError: null }];
        return record;
    });
}
async function saved(context, exports, mode, format) {
    const state = await loadBoardState(context);
    const preview = await exports.preview("search-fixture", undefined, { promptMode: mode, formats: [format] },
        { kind: "all", revision: state.revision });
    await exports.review("search-fixture", preview.previewId, true);
    return (await exports.confirm("search-fixture", preview.previewId, true)).bundle;
}
function reader(engine) {
    let requestId = 0;
    return async (query, types = []) => {
        let hits, receipt;
        const status = await engine.search({ query, types, requestId: requestId++ }, (value, token) => { hits = value; receipt = token; });
        return { status, hits, receipt };
    };
}
test("gated real hybrid path preserves paraphrases, exact anchors, long tails, Unicode and every typed source", { timeout: 120000 }, async t => {
    const { context } = await privateFixture(t, records());
    await seedRetainedReply(context, inventedSource(), "The lab results show a steady recovery.");
    const exports = createExportController(context);
    const original = await saved(context, exports, "original", "json");
    await saved(context, exports, "masked", "json");
    const none = await saved(context, exports, "none", "json");
    const preview = await exports.previewComparison("search-fixture", original.bundleId, none.bundleId, { formats: ["json"] });
    await exports.reviewComparison("search-fixture", preview.previewId, true);
    await exports.confirmComparison("search-fixture", preview.previewId, true);
    const engine = createSearchRetrieval(context, { source: inventedSource, onInvalidate: () => {} });
    t.after(() => engine.close());
    const built = await engine.build();
    assert.equal(built.mode, "hybrid"); assert.match(built.indexId, /^[a-f0-9]{64}$/);
    const read = reader(engine);
    const positive = await read("A doctor cared for somebody who was hurt.", ["interaction"]);
    assert.equal(positive.hits[0].target.href, "#request?request=clinical");
    assert.equal(positive.hits[0].match, "semantic");
    const docWords = new Set(permittedSearchText(positive.hits[0]).toLowerCase().match(/\p{L}+/gu));
    assert.ok("A doctor cared for somebody who was hurt".toLowerCase().match(/\p{L}+/gu).every(word => !docWords.has(word)));
    for (const [query, id] of [["Someone fixed a damaged vehicle.", "vehicle"], ["Staff are locked out and must renew authentication.", "access"]]) {
        const result = await read(query, ["interaction"]);
        assert.equal(result.hits[0].target.href, `#request?request=${id}`);
        assert.equal(result.hits[0].match, "semantic");
    }
    for (const negative of ["Distant galaxies contain enormous black holes.", "A recipe for chocolate cake and vanilla icing.",
        "A hospital accountant calculated quarterly payroll."]) {
        const result = await read(negative);
        assert.equal(result.status.state, "no-match"); assert.deepEqual(result.hits, []);
    }
    const exact = await read("workiq-fetch");
    assert.equal(exact.hits[0].type, "tool");
    assert.equal(exact.hits[0].match, "exact");
    const prefix = await read("workiq-fet", ["tool"]);
    assert.equal(prefix.hits[0].title, "workiq-fetch"); assert.equal(prefix.hits[0].match, "prefix");
    const anchor = await read("GET /me/calendarView 403", ["action"]);
    assert.ok(anchor.hits.length > 0);
    assert.ok(anchor.hits.every(hit => /403/.test(hit.content) && /GET/.test(hit.content)));
    assert.deepEqual((await read("GET /me/calendarView 599", ["action"])).hits, []);
    assert.ok((await read("中文检索", ["interaction"])).hits.some(hit => hit.target.href.endsWith("unicode")));
    const tail = await read("An astronaut piloted the spacecraft into lunar orbit.", ["interaction"]);
    assert.equal(tail.hits[0].target.href, "#request?request=tail");
    assert.match(tail.hits[0].excerpt, /lunar orbit/);
    const longQuery = "Invented unrelated budget material. ".repeat(100) + " An astronaut piloted the spacecraft into lunar orbit.";
    assert.ok((await read(longQuery, ["interaction"])).hits.some(hit => hit.target.href.endsWith("tail")));
    const queries = { interaction: "physician", context: "subsequent medical", reply: "lab results", action: "403",
        tool: "workiq-fetch", service: "Calendar", report: "Saved report", comparison: "Saved comparison",
        view: "Recorded timing", setting: "Theme" };
    for (const type of SEARCH_TYPES) {
        const result = await read(queries[type], [type]);
        assert.ok(result.hits.length > 0, type);
        assert.ok(result.hits.every(hit => hit.type === type));
        assert.equal(new Set(result.hits.map(hit => hit.id)).size, result.hits.length);
        assert.ok(Object.isFrozen(result.hits[0]));
        assert.equal(Object.hasOwn(result.hits[0], "similarity"), false);
        const expectedSource = ({ reply: "retained-reply", report: "saved-report", comparison: "saved-comparison",
            view: "fixed-navigation", setting: "fixed-navigation" })[type] ?? "retained-activity";
        assert.ok(result.hits.every(hit => hit.source.kind === expectedSource));
    }
    const reports = await read("Saved report", ["report"]);
    assert.deepEqual(new Set(reports.hits.map(hit => hit.coverage.textMode)), new Set(["original", "masked", "none"]));
    assert.ok((await read("physician", ["report"])).hits.every(hit => hit.coverage.textMode !== "none"));
    const tied = await read("subsequent medical", ["context"]);
    const repeated = await read("subsequent medical", ["context"]);
    assert.deepEqual(tied.hits.map(hit => hit.id), repeated.hits.map(hit => hit.id));
    assert.equal(tied.receipt.indexId, repeated.receipt.indexId);
    assert.doesNotMatch(JSON.stringify(engine.status()), /doctor cared|lunar orbit|SYNTHETIC_PRIVATE/);
    t.diagnostic(JSON.stringify({ initialBuild: built.metrics, lastSearch: engine.status().metrics, model: engine.status().model,
        items: built.items, chunks: built.chunks }));
});

test("lexical policy preserves Unicode and identifier/status precision without metadata embedding", () => {
    assert.equal(lexicalMatch("workiq-fet", { title: "workiq-fetch", text: "workiq-fetch" }).tier, 1);
    assert.equal(lexicalMatch("403", { title: "", text: "200" }).blocked, true);
    assert.equal(lexicalMatch("403", { title: "", text: "4030" }).blocked, true);
    assert.equal(lexicalMatch("GET", { title: "", text: "getting" }).blocked, true);
    assert.equal(lexicalMatch("中文", { title: "", text: "中文检索" }).tier, 1);
    assert.equal(lexicalMatch("get a report", { title: "", text: "Saved reports" }).blocked, false);
    assert.equal(lexicalMatch("sign-in problems", { title: "", text: "Authentication errors" }).blocked, false);
    assert.equal(permittedSearchText({ title: "Allowed", content: "Visible", source: { label: "Local", id: "HIDDEN_ID" },
        target: "HIDDEN_PATH", revision: "HIDDEN_REVISION", coverage: { linkedInteractions: ["HIDDEN_LINK"] } }), "Allowed\nVisible\nLocal");
});

test("matching structured anchors allow real semantic prose while missing anchors reject", async t => {
    const model = createSearchModel();
    t.after(() => model.close());
    const text = "GET /me/calendarView 403\nEmployees cannot sign in because their credentials have expired.";
    const item = { id: "invented-action", revision: "invented-revision", type: "action", title: "Recorded action",
        text, chunks: await model.embed(text) };
    const rank = async query => rankSearch([item], query, await model.embed(query), ["action"], new AbortController().signal);
    assert.equal((await rank("GET /me/calendarView 403"))[0].match, "exact");
    const hits = await rank("GET /me/calendarView 403 authentication failure");
    assert.equal(hits.length, 1, "Present anchors must allow the remaining prose to match semantically");
    assert.equal(hits[0].match, "semantic");
    assert.equal(hits[0].id, item.id);
    for (const query of ["POST /me/calendarView 403 authentication failure",
        "GET /me/messages 403 authentication failure", "GET /me/calendarView 401 authentication failure"]) {
        assert.deepEqual(await rank(query), [], "A missing required anchor must still reject a semantically similar action");
    }
});

test("latest query and invalidate/close cancel real work; changed current source cannot disclose", { timeout: 120000 }, async t => {
    const { context } = await privateFixture(t, records().slice(0, 2));
    await seedRetainedReply(context);
    let source = inventedSource(), entered, invalidations = 0;
    const engine = createSearchRetrieval(context, { source: () => source, onInvalidate: () => { invalidations++; },
        onModelActivity: event => { if (event.state === "computed") entered?.resolve(); } });
    t.after(() => engine.close());
    await engine.build();
    entered = Promise.withResolvers();
    let oldDisclosed = false;
    const old = engine.search({ query: "Invented material. ".repeat(1500), requestId: 0 }, () => { oldDisclosed = true; });
    await entered.promise;
    let newest;
    const latest = engine.search({ query: "workiq-fetch", requestId: 1, types: ["tool"] }, values => { newest = values; });
    assert.equal((await old).state, "superseded");
    await latest;
    assert.equal(oldDisclosed, false); assert.equal(newest[0].title, "workiq-fetch");
    assert.equal((await engine.search({ query: "old", requestId: 0 }, () => assert.fail())).state, "superseded");
    entered = Promise.withResolvers();
    const revoked = engine.search({ query: "Retained reply", requestId: 2 }, () => assert.fail("Changed source must not disclose"));
    await entered.promise;
    source = { available: false, sourceConfigRef: null, sourceConfigRevision: 0 };
    assert.equal((await revoked).state, "stale");
    assert.equal(engine.status().items, 0);
    assert.equal(engine.status().mode, "unavailable");
    await engine.build();
    entered = Promise.withResolvers();
    const pending = engine.search({ query: "Invented private material. ".repeat(1500), requestId: 3 }, () => assert.fail());
    await entered.promise;
    engine.invalidate();
    assert.equal(engine.status().items, 0);
    assert.equal((await pending).state, "superseded");
    entered = Promise.withResolvers();
    const rebuilding = engine.build();
    await entered.promise;
    engine.invalidate();
    assert.equal((await rebuilding).state, "superseded");
    assert.ok(invalidations >= 3);
    await engine.build();
    entered = Promise.withResolvers();
    const closingQuery = engine.search({ query: "Invented private material. ".repeat(1500), requestId: 4 }, () => assert.fail());
    await entered.promise;
    await engine.close();
    assert.equal((await closingQuery).state, "closed");
    assert.equal(engine.status().state, "closed");
});

test("missing/corrupt model has honest lexical-only availability and never semantic success", async t => {
    const { root, context } = await privateFixture(t, records().slice(0, 1));
    const engine = createSearchRetrieval(context, { source: inventedSource, modelDirectory: path.join(root, "no-model"), onInvalidate: () => {} });
    t.after(() => engine.close());
    const built = await engine.build();
    assert.equal(built.mode, "lexical-only"); assert.equal(built.model.code, "model-missing");
    const read = reader(engine);
    assert.equal((await read("workiq-fetch", ["tool"])).hits[0].match, "exact");
    const paraphrase = await read("A doctor cared for somebody who was hurt.", ["interaction"]);
    assert.deepEqual(paraphrase.hits, []); assert.equal(paraphrase.status.mode, "lexical-only");
    assert.ok((await readdir(context.dataDir)).every(name => !/search|index|query/.test(name)));
});

test("PDF revalidation is measured in the full gated path and artifact deletion removes derived hits", { timeout: 120000 }, async t => {
    const { context } = await privateFixture(t, records().slice(0, 1));
    const exports = createExportController(context), pdf = await saved(context, exports, "original", "pdf");
    const engine = createSearchRetrieval(context, { source: inventedSource, onInvalidate: () => {} });
    t.after(() => engine.close());
    const bytes = await readFile(pdf.files["product-report.pdf"]);
    const built = await engine.build(), read = reader(engine);
    assert.equal(built.mode, "hybrid");
    const result = await read("physician", ["report"]);
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].target.kind, "open-saved-report-file");
    assert.equal(result.hits[0].target.format, "pdf");
    assert.deepEqual(await readFile(pdf.files["product-report.pdf"]), bytes);
    t.diagnostic(JSON.stringify({ pdfBuild: built.metrics, pdfSearch: result.status.metrics, model: result.status.model }));
    const parserStarted = Promise.withResolvers(), originalFork = childProcess.fork;
    const mock = t.mock.method(childProcess, "fork", (modulePath, args, options) => {
        const child = originalFork(modulePath, args, options);
        if (String(modulePath).endsWith("search-corpus-pdf-worker.mjs")) parserStarted.resolve(child);
        return child;
    });
    syncBuiltinESMExports();
    try {
        const pending = read("physician", ["report"]);
        const parser = await parserStarted.promise;
        const superseding = await read("changed query", ["report"]);
        assert.equal(superseding.status.state, "stale");
        assert.equal((await pending).status.state, "superseded");
        assert.equal(parser.killed, true);
        assert.equal(engine.status().items, 0);
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
    await engine.build();
    await writeFile(pdf.files["product-report.pdf"], "BROKEN_INVENTED_PDF");
    const changed = await read("physician", ["report"]);
    assert.equal(changed.hits, undefined); assert.equal(engine.status().items, 0);
    await writeFile(pdf.files["product-report.pdf"], bytes);
    await engine.build();
    const deletion = createDeletionController(context, { describeSavedArtifact: createSavedArtifactDescriptor(context),
        onSeal: () => { engine.invalidate(); } });
    const preview = await deletion.previewArtifact("search-fixture", { artifactKind: "report", artifactId: pdf.bundleId });
    await deletion.confirmArtifact("search-fixture", { operationId: preview.operationId, confirmed: true });
    assert.equal(engine.status().items, 0);
    await engine.build();
    assert.deepEqual((await read("physician", ["report"])).hits, []);
});
