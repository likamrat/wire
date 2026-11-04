import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createSearchRetrieval } from "../lib/search-retrieval.mjs";
import { indexSearchText, rankTextSearch, textSearchHit, normalizeSearchText } from "../lib/search-text.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, updateBoardState, replaceEvidence } from "../lib/store.mjs";
import { readSavedReportFile, reportHash } from "../lib/report-artifacts.mjs";
import { fixture, privateFixture } from "./helpers.mjs";
import { inventedSource, seedRetainedReply } from "./search-corpus-fixture.mjs";
import { forbidSearchAi } from "./search-text-guards.mjs";

const forbidInference = (t, options) => forbidSearchAi(t, options).verify;
const row = (id, text) => ({
    ...fixture(id), sourceSessionName: "Invented local source", followUpPrompts: [],
    userPrompt: { text, status: "full", provenance: "human-authored" },
});

test("text modules import independently without a cycle or any inference dependency", async () => {
    for (const file of ["search-text.mjs", "search-wire-contract.mjs", "search-retrieval.mjs"]) {
        const url = new URL(`../lib/${file}`, import.meta.url).href;
        const program = `
            import { registerHooks } from "node:module";
            registerHooks({ resolve(specifier, context, next) {
                if (/search-model|search-linguistics|search-ranking|search-intent|onnxruntime|@huggingface|copilot-sdk/.test(specifier)) {
                    throw new Error("Unexpected inference dependency: " + specifier);
                }
                return next(specifier, context);
            } });
            await import(${JSON.stringify(url)});
            console.log("text-only import");
        `;
        const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", program], { cwd: process.cwd() });
        assert.equal(result.stdout.trim(), "text-only import");
    }
});

test("field-local literal matches have truthful original ranges and deterministic title priority", async () => {
    const entry = (id, title, content, label) => ({ id, revision: id, type: "report", title, content, source: { label } });
    const entries = [
        entry("body", "Unrelated title", "Before PowerPoint after", "Approved file"),
        entry("source", "Another title", "Unrelated content", "PowerPoint source"),
        entry("title", "PowerPoint overview", "Unrelated content", "Approved file"),
        entry("whole", "Power", "Unrelated content", "Approved file"),
        entry("split", "Pow", "erPoint", "Approved file"),
    ];
    const items = entries.map(indexSearchText);
    const hits = await rankTextSearch(items, "  POWER  ", [], new AbortController().signal);
    assert.deepEqual(hits.map(hit => hit.id), ["whole", "title", "body", "source"]);
    for (const hit of hits) {
        const original = entries.find(entry => entry.id === hit.id), result = textSearchHit(original, hit), range = result.textMatch;
        const field = range.field === "source" ? original.source.label : original[range.field];
        assert.equal(field.slice(range.excerptStart, hit.excerptEnd), result.excerpt);
        assert.equal(field.slice(range.start, range.end).toLowerCase(), "power");
        assert.equal(result.excerpt.slice(range.start - range.excerptStart, range.end - range.excerptStart).toLowerCase(), "power");
    }
    assert.deepEqual((await rankTextSearch(items, "Power  Point", [], new AbortController().signal)), []);
    assert.deepEqual((await rankTextSearch(items, "Power", ["interaction"], new AbortController().signal)), []);
});

test("length-changing Unicode normalization maps onto intact original graphemes", async () => {
    for (const [text, query, marked] of [
        ["Lead \uFB03 PowerPoint", "FFI", "\uFB03"],
        ["\uFB03 ".repeat(150) + "PowerPoint tail", "POWER", "Power"],
        ["Cafe\u0301 notes", "CAF\u00C9", "Cafe\u0301"],
        ["\uFF30\uFF4F\uFF57\uFF45\uFF52Point", "power", "\uFF30\uFF4F\uFF57\uFF45\uFF52"],
        ["\u0130stanbul", "i", "\u0130"],
        ["\u3131\u314F notes", "\uAC00", "\u3131\u314F"],
        ["Before \u{1F469}\u200D\u{1F4BB} after", "\u{1F4BB}", "\u{1F469}\u200D\u{1F4BB}"],
        ["\u039F\u03A3", "\u03C2", "\u03A3"],
    ]) {
        const entry = { id: "unicode", revision: "1", type: "interaction", title: "", content: text, source: { label: "" } };
        const [hit] = await rankTextSearch([indexSearchText(entry)], query, [], new AbortController().signal);
        assert.ok(hit, text);
        const result = textSearchHit(entry, hit), range = result.textMatch;
        assert.equal(text.slice(range.start, range.end), marked);
        assert.ok(normalizeSearchText(result.excerpt).includes(normalizeSearchText(query.trim())));
        const boundaries = new Set([0, text.length, ...[...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text)].map(value => value.index)]);
        for (const offset of [range.start, range.end, range.excerptStart, hit.excerptEnd]) assert.ok(boundaries.has(offset));
    }
});

test("Greek sigma casing matches literal partial text in both final and nonfinal contexts", async () => {
    for (const text of ["\u039F\u03A3", "\u039F\u03A3\u0391", "\u03BF\u03C3", "\u03BF\u03C2", "\u03BF\u03C2\u03B1"]) {
        for (const query of ["\u03A3", "\u03C3", "\u03C2", "\u039F\u03A3", "\u03BF\u03C3", "\u03BF\u03C2"]) {
            const entry = { id: "sigma", revision: "1", type: "interaction", title: "", content: text, source: { label: "" } };
            const hits = await rankTextSearch([indexSearchText(entry)], query, [], new AbortController().signal);
            assert.equal(hits.length, 1, `${query} / ${text}`);
            const result = textSearchHit(entry, hits[0]), range = result.textMatch;
            assert.ok(normalizeSearchText(text.slice(range.start, range.end)).includes(normalizeSearchText(query)));
            assert.ok(normalizeSearchText(result.excerpt).includes(normalizeSearchText(query)));
        }
    }
});

async function saveReport(context, exports, scenarioId, format) {
    const state = await loadBoardState(context);
    const preview = await exports.preview("literal-fixture", undefined, { promptMode: "original", formats: [format] },
        { kind: "selected", revision: state.revision, scenarioIds: [scenarioId] });
    await exports.review("literal-fixture", preview.previewId, true);
    return (await exports.confirm("literal-fixture", preview.previewId, true)).bundle;
}

// Build an approved, owned HTML-title fixture; production never reseals changed files.
async function setFixtureTitle(context, bundle, title) {
    const file = bundle.files["product-report.html"], manifestFile = bundle.files["coverage-and-redaction-manifest.json"];
    const html = (await fs.readFile(file, "utf8")).replace(/<title>[^<]*<\/title>/u, `<title>${title}</title>`);
    const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    delete manifest.title;
    manifest.files["product-report.html"] = { sha256: reportHash(html), bytes: Buffer.byteLength(html) };
    const bytes = JSON.stringify(manifest);
    await fs.writeFile(file, html);
    await fs.writeFile(manifestFile, bytes);
    await updateBoardState(context, state => {
        const entry = state.exports.find(entry => entry.bundleId === bundle.bundleId);
        delete entry.title;
        entry.manifestHash = reportHash(bytes);
    });
}

test("generated saved HTML title-only and real report body extraction match POWER with original source and target", async t => {
    const noInference = forbidInference(t);
    const records = [row("body", "Prepare the PowerPoint bodymarker presentation."),
        row("title", "Describe a quiet planning session."), row("source", "Review the quarterly schedule.")];
    records[2].sourceSessionName = "PowerPoint source-label-only";
    records[0].followUpPrompts = [{ text: "PowerPoint follow-up marker", status: "full", provenance: "human-authored" }];
    const { context } = await privateFixture(t, records), exports = createExportController(context);
    await seedRetainedReply(context, inventedSource(), "PowerPoint retained reply marker");
    const body = await saveReport(context, exports, "body", "html");
    const title = await saveReport(context, exports, "title", "html");
    await setFixtureTitle(context, title, "PowerPoint title-only");
    const engine = createSearchRetrieval(context, { source: inventedSource, onInvalidate: () => {} });
    t.after(() => engine.close());
    assert.equal((await engine.build()).mode, "text");
    let hits, repeated;
    const types = ["interaction", "context", "reply", "report"];
    await engine.search({ query: "POWER", requestId: 0, types }, value => { hits = value; });
    await engine.discover({ query: "POWER", requestId: 1, types }, value => { repeated = value; });
    assert.equal(hits.length, 6);
    assert.equal(new Set(hits.map(hit => hit.id)).size, 6);
    assert.deepEqual(repeated.matches.hits, hits);
    assert.equal(Object.hasOwn(repeated, "related"), false);
    const reportTitle = hits.find(hit => hit.target.bundleId === title.bundleId);
    assert.equal(reportTitle.textMatch.field, "title");
    assert.equal(reportTitle.title, "PowerPoint title-only");
    assert.doesNotMatch(reportTitle.content, /power/i);
    const reportBody = hits.find(hit => hit.target.bundleId === body.bundleId);
    assert.equal(reportBody.type, "report");
    assert.equal(reportBody.textMatch.field, "content");
    assert.match(reportBody.excerpt, /PowerPoint bodymarker/);
    assert.equal(reportBody.source.kind, "saved-report");
    assert.equal(reportBody.target.kind, "open-saved-report");
    const saved = await readSavedReportFile(context, await loadBoardState(context), body.bundleId, "html");
    assert.equal(reportBody.target.documentHash, saved.sha256);
    const source = hits.find(hit => hit.type === "interaction" && hit.target.href === "#request?request=source");
    assert.equal(source.textMatch.field, "source");
    assert.equal(source.excerpt, "PowerPoint source-label-only");
    assert.ok(hits.some(hit => hit.type === "context" && /follow-up/.test(hit.excerpt)));
    assert.ok(hits.some(hit => hit.type === "reply" && /retained reply/.test(hit.excerpt)));
    noInference();

    await fs.appendFile(body.files["product-report.html"], "<!-- unapproved change -->");
    let staleDisclosed = false;
    await engine.search({ query: "bodymarker", requestId: 2, types: ["report"] }, () => { staleDisclosed = true; });
    assert.equal(staleDisclosed, false);
    const partial = await engine.build();
    assert.equal(partial.state, "partial");
    let remaining;
    const result = await engine.search({ query: "bodymarker", requestId: 3, types: ["report"] }, value => { remaining = value; });
    assert.deepEqual(remaining, []);
    assert.equal(result.state, "partial", "An unreadable/tampered report must not become a complete no-match result.");
    assert.ok(result.corpus.issues.some(issue => issue.code === "stale-or-integrity"));
});

test("source-only matches retain distinct original prompt, follow-up and reply previews with revision-bound titles", async t => {
    const noInference = forbidInference(t);
    const records = [row("chat", "Prepare the quarterly agenda."), row("missing", "")];
    records[0].sourceSessionName = records[1].sourceSessionName = "PowerPoint planning source";
    records[0].followUpPrompts = [
        { text: "Check the budget summary.", status: "full", provenance: "human-authored" },
        { text: "Send the revised numbers.", status: "full", provenance: "human-authored" },
    ];
    records[1].userPrompt = { status: "unavailable", text: null };
    const { context } = await privateFixture(t, records);
    await seedRetainedReply(context, inventedSource(), "The agenda includes three review items.");
    const engine = createSearchRetrieval(context, { source: inventedSource, onInvalidate: () => {} });
    t.after(() => engine.close());
    const firstIndex = (await engine.build()).indexId;
    let hits, reply;
    await engine.search({ query: "POWER", requestId: 0, types: ["interaction", "context"] }, value => { hits = value; });
    assert.equal(hits.length, 4);
    assert.ok(hits.every(hit => hit.textMatch.field === "source" && hit.source.label === "PowerPoint planning source"));
    const available = hits.filter(hit => hit.coverage.completeness !== "unavailable");
    assert.deepEqual(new Set(available.map(hit => hit.title)),
        new Set(["Prepare the quarterly agenda.", "Check the budget summary.", "Send the revised numbers."]));
    assert.ok(available.every(hit => hit.content.includes(hit.title)));
    const missing = hits.find(hit => hit.coverage.completeness === "unavailable");
    assert.equal(missing.title, "Recorded request");
    assert.equal(missing.content, "");
    await engine.search({ query: "LOCALLY RETAINED", requestId: 1, types: ["reply"] }, value => { reply = value[0]; });
    assert.equal(reply.title, "The agenda includes three review items.");
    assert.equal(reply.textMatch.field, "source");
    assert.equal(reply.source.label, "Locally retained Copilot reply");
    assert.equal(reply.excerpt, reply.source.label);

    const original = available.find(hit => hit.type === "interaction");
    records[0].userPrompt.text = "Review the newly revised agenda.";
    await replaceEvidence(context, () => ({ records, importCoverage: { counts: { includedSessions: 1, includedProjects: 1 }, roster: [] } }));
    await engine.search({ query: "POWER", requestId: 2 }, () => assert.fail("An old title receipt disclosed after content replacement."));
    const nextIndex = (await engine.build()).indexId;
    assert.notEqual(nextIndex, firstIndex);
    await engine.search({ query: "POWER", requestId: 3, types: ["interaction"] }, value => {
        const changed = value.find(hit => hit.id === original.id);
        assert.equal(changed.title, "Review the newly revised agenda.");
        assert.notEqual(changed.revision, original.revision);
    });
    noInference();
});

test("retained titles are bounded original grapheme slices without synthetic ellipses or lost body matches", async t => {
    const noInference = forbidInference(t);
    const text = "  \u{1F469}\u200D\u{1F4BB} " + "Original planning detail ".repeat(40) + "PowerPoint tail";
    const { context } = await privateFixture(t, [row("long-title", text)]);
    const engine = createSearchRetrieval(context, { source: inventedSource, onInvalidate: () => {} });
    t.after(() => engine.close());
    await engine.build();
    await engine.search({ query: "POWER", requestId: 0, types: ["interaction"] }, hits => {
        assert.equal(hits.length, 1);
        const hit = hits[0], segments = [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(hit.title)];
        assert.ok(segments.length <= 120);
        assert.equal(hit.title, text.slice(2, 2 + hit.title.length));
        assert.ok(hit.title.startsWith("\u{1F469}\u200D\u{1F4BB}"));
        assert.equal(hit.title.includes("\u2026"), false);
        assert.equal(hit.content, text);
        assert.equal(hit.textMatch.field, "content");
        assert.match(hit.excerpt, /PowerPoint tail/);
    });
    noInference();
});

test("JSON, Markdown and PDF saved report bodies use real non-AI extraction", { timeout: 60000 }, async t => {
    const noInference = forbidInference(t, { pdf: true });
    const { context } = await privateFixture(t, [row("body", "PowerPoint format body marker")]);
    const exports = createExportController(context), bundles = [];
    for (const format of ["json", "markdown", "pdf"]) bundles.push(await saveReport(context, exports, "body", format));
    const engine = createSearchRetrieval(context, { source: inventedSource, onInvalidate: () => {} });
    t.after(() => engine.close());
    assert.equal((await engine.build()).mode, "text");
    let hits;
    await engine.search({ query: "POWER", requestId: 0, types: ["report"] }, value => { hits = value; });
    assert.deepEqual(new Set(hits.map(hit => hit.target.bundleId)), new Set(bundles.map(bundle => bundle.bundleId)));
    assert.deepEqual(new Set(hits.map(hit => hit.target.format)), new Set(["json", "markdown", "pdf"]));
    for (const hit of hits) {
        assert.equal(hit.textMatch.field, "content");
        assert.match(hit.excerpt, /PowerPoint/);
        assert.equal(hit.target.kind, "open-saved-report-file");
    }
    await engine.close();
    noInference();
});

test("replacement, invalidation and empty queries retain their distinct text-search outcomes", async t => {
    const noInference = forbidInference(t);
    const { context } = await privateFixture(t, [row("power", "PowerPoint planning"), row("calendar", "Calendar planning")]);
    await seedRetainedReply(context, inventedSource(), "An unrelated retained reply.");
    let source = inventedSource();
    const engine = createSearchRetrieval(context, { source: () => source, onInvalidate: () => {} });
    t.after(() => engine.close());
    assert.equal((await engine.build()).state, "ready");
    const old = engine.search({ query: "POWER", requestId: 0 }, () => assert.fail("A superseded result was disclosed."));
    let latest;
    const current = engine.search({ query: "Calendar planning", requestId: 1, types: ["interaction"] }, hits => { latest = hits; });
    assert.equal((await old).state, "superseded");
    await current;
    assert.deepEqual(latest.map(hit => hit.target.href), ["#request?request=calendar"]);
    let requestId = 2;
    for (const [oldMethod, nextMethod] of [["discover", "search"], ["search", "discover"]]) {
        const replaced = engine[oldMethod]({ query: "POWER", requestId: requestId++ }, () => assert.fail("Replaced text query disclosed."));
        let found;
        const replacement = engine[nextMethod]({ query: "Calendar planning", requestId: requestId++, types: ["interaction"] }, value => { found = value; });
        assert.equal((await replaced).state, "superseded");
        await replacement;
        assert.equal(nextMethod === "search" ? found.length : found.matches.hits.length, 1);
    }
    let empty;
    assert.equal((await engine.search({ query: "   ", requestId: requestId++ }, hits => { empty = hits; })).state, "empty");
    assert.deepEqual(empty, []);
    assert.equal((await engine.search({ query: "no-such-literal", requestId: requestId++ }, hits => assert.deepEqual(hits, []))).state, "no-match");
    const pending = engine.search({ query: "POWER", requestId: requestId++ }, () => assert.fail("Changed-source text was disclosed."));
    source = { available: false, sourceConfigRef: null, sourceConfigRevision: 0 };
    assert.equal((await pending).state, "stale");
    assert.equal(engine.status().indexId, null);
    noInference();
});

test("asynchronous disclosure is unavailable and text queries do not create stored query/index files", async t => {
    const noInference = forbidInference(t), { context } = await privateFixture(t, [row("power", "PowerPoint notes")]);
    const before = await fs.readdir(context.dataDir);
    const engine = createSearchRetrieval(context, { source: inventedSource, onInvalidate: () => {} });
    t.after(() => engine.close());
    await engine.build();
    const result = await engine.discover({ query: "POWER", requestId: 0 }, () => Promise.resolve());
    assert.equal(result.state, "unavailable");
    assert.equal(engine.status().items, 0);
    assert.equal(engine.status().indexId, null);
    assert.deepEqual(await fs.readdir(context.dataDir), before);
    noInference();
});

test("private values and routing metadata never become new searchable text", async t => {
    const noInference = forbidInference(t);
    const record = row("hidden-routing-marker", "PowerPoint notes password='not-searchable-secret'");
    record.notes = "hidden-notes-marker";
    const { context } = await privateFixture(t, [record]);
    const engine = createSearchRetrieval(context, { source: inventedSource, onInvalidate: () => {} });
    t.after(() => engine.close());
    await engine.build();
    let requestId = 0;
    for (const query of ["not-searchable-secret", "hidden-routing-marker", "hidden-notes-marker", "wire-search-v1"]) {
        await engine.search({ query, requestId: requestId++, types: ["interaction"] }, hits => assert.deepEqual(hits, [], query));
    }
    await engine.search({ query: "POWER", requestId: requestId++, types: ["interaction"] }, hits => {
        assert.equal(hits.length, 1);
        assert.doesNotMatch(hits[0].excerpt, /not-searchable-secret/);
    });
    noInference();
});

test("complete long records and long literal queries include the final tail without a chunk or page cutoff", async t => {
    const noInference = forbidInference(t);
    const prefix = "Ordinary saved planning text. ";
    const text = prefix.repeat(3000) + "PowerPoint final tail";
    const { context } = await privateFixture(t, [row("long", text)]);
    const engine = createSearchRetrieval(context, { source: inventedSource, onInvalidate: () => {} });
    t.after(() => engine.close());
    await engine.build();
    for (const [requestId, query] of ["POWER", prefix.repeat(200) + "PowerPoint"].entries()) {
        await engine.search({ query, requestId, types: ["interaction"] }, hits => {
            assert.equal(hits.length, 1);
            assert.equal(hits[0].content, text);
            assert.ok(hits[0].textMatch.start > 70000);
            assert.ok(normalizeSearchText(hits[0].excerpt).includes(normalizeSearchText(query.trim())));
        });
    }
    noInference();
});

test("closing text Search waits for actual active PDF extraction to terminate", { timeout: 15000 }, async t => {
    const started = Promise.withResolvers();
    const noInference = forbidInference(t, { pdf: true, onPdf: child => started.resolve(child) });
    const { context } = await privateFixture(t, [row("body", "PowerPoint PDF cancellation marker")]);
    await saveReport(context, createExportController(context), "body", "pdf");
    const engine = createSearchRetrieval(context, { source: inventedSource, onInvalidate: () => {} });
    t.after(() => engine.close());
    const building = engine.build();
    const child = await Promise.race([started.promise, building.then(() => { throw new Error("No PDF parser started."); })]);
    await engine.close();
    assert.equal((await building).state, "closed");
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(engine.status().indexId, null);
    noInference();
});

test("actual corpus text search finds POWER and middle-of-word text without initializing any model", async t => {
    const noInference = forbidInference(t);
    const { context } = await privateFixture(t, [
        row("slides", "Prepare a PowerPoint presentation."),
        row("unrelated", "Arrange a calendar meeting."),
        row("denial", "did not repair the car"),
    ]);
    const engine = createSearchRetrieval(context, { source: inventedSource, onInvalidate: () => {} });
    t.after(() => engine.close());
    const built = await engine.build();
    noInference();
    assert.equal(built.mode, "text");
    assert.equal(Object.hasOwn(built, "model"), false);
    let requestId = 0;
    for (const [query, expected] of [
        ["POWER", ["#request?request=slides"]],
        ["owerp", ["#request?request=slides"]],
        ["PowerPoint presentation", ["#request?request=slides"]],
        ["presentation PowerPoint", []],
        ["slideshow", []],
        ["repair the car", ["#request?request=denial"]],
    ]) {
        let hits;
        await engine.search({ query, requestId: requestId++, types: ["interaction"] }, value => { hits = value; });
        assert.deepEqual(hits.map(hit => hit.target.href), expected, query);
        assert.ok(hits.every(hit => hit.match === "text"));
    }
    noInference();
});
