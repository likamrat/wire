import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSearchRetrieval } from "../lib/search-retrieval.mjs";
import { createSearchLinguistics } from "../lib/search-linguistics.mjs";
import { readSearchLinguistics, SEARCH_LINGUISTICS, SEARCH_INTENT_POLICY_ID } from "../lib/search-linguistics-assets.mjs";
import { createWordNet } from "../lib/search-wordnet.mjs";
import { createSearchIntent, validSearchIntent } from "../lib/search-intent.mjs";
import { fixture, privateFixture } from "./helpers.mjs";
import { inventedSource, seedRetainedReply } from "./search-corpus-fixture.mjs";
import { searchHash } from "../lib/search-model-assets.mjs";
import { originalDocuments as prompts, originalExpectations, rawRequiredPairs, ordinaryDocuments,
    ordinaryExpectations, contrastInventories, assertSearchPopulation } from "./search-linguistics-fixture.mjs";
import { provisionSearchLinguistics } from "../scripts/provision-search-linguistics.mjs";
import { createExportController } from "../lib/export.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { createSavedArtifactDescriptor } from "../lib/report-artifacts.mjs";
import { loadBoardState } from "../lib/store.mjs";

const directory = process.env.WIRE_SEARCH_LINGUISTICS_TEST_DIRECTORY;
const modelDirectory = process.env.WIRE_SEARCH_MODEL_TEST_DIRECTORY;
const resourceTest = { skip: !directory, timeout: 120000 };
function records(count = prompts.length, repeated = false) {
    return Array.from({ length: count }, (_, i) => {
        const row = fixture(`search-${i}`);
        row.sourceSessionName = `Invented acceptance conversation ${i}`;
        row.userPrompt.text = repeated ? prompts[1] : prompts[i];
        row.followUpPrompts = [];
        row.httpRecords = [{ recordId: `http-${i}`, classification: "direct-graph-http", synthetic: false,
            observedGraphHttp: true, responseOrigin: "https://graph.microsoft.com", method: "GET", apiVersion: "v1.0",
            responsePath: { path: "/me/calendarView", query: [] }, startedAt: row.capturedAt,
            durationMs: 12, status: i === 0 ? 403 : 200, transportError: null }];
        return row;
    });
}
function reader(engine) {
    let requestId = 0;
    return async (query, types = ["interaction"], discovery = false) => {
        let hits, related;
        const input = { query, types, requestId: requestId++ };
        const status = discovery ? await engine.discover(input, result => { hits = result.matches.hits; related = result.related; })
            : await engine.search(input, value => { hits = value; });
        assert.ok(hits, "A completed authorized query must disclose even its empty result");
        return { hits, related, status };
    };
}
const targetIndices = hits => hits.map(hit => Number(new URLSearchParams(hit.target.href.split("?")[1]).get("request").split("-")[1]));
test("linguistic resources stay opt-in and have a fixed complete licensed file set", () => {
    const helper = createSearchLinguistics();
    assert.equal(helper.enabled, false);
    assert.equal(helper.status().state, "disabled");
    assert.equal(SEARCH_LINGUISTICS.files.length, 10);
    assert.equal(SEARCH_LINGUISTICS.files.reduce((sum, file) => sum + file.bytes, 0), 23789691);
    assert.ok(SEARCH_LINGUISTICS.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
    assert.equal(validSearchIntent({ policyId: SEARCH_INTENT_POLICY_ID, state: "unsupported", reason: "relative-attachment" }, ""), true);
    assert.equal(validSearchIntent({ policyId: "wrong", state: "unsupported", reason: "relative-attachment" }, ""), false);
});
test("cancellation at linguistic helper startup settles without sending an orphaned initialization", async t => {
    const controller = new AbortController();
    const helper = createSearchLinguistics({ directory: "not-read-after-cancellation",
        onActivity: event => { if (event.state === "starting") controller.abort(); } });
    t.after(() => helper.close());
    await assert.rejects(helper.prepare([], { signal: controller.signal }), error => error.code === "linguistics-cancelled");
    assert.equal(helper.status().state, "cancelled");
});
test("qualification: original required positives and forbidden results apply independently to default and optional search", resourceTest, async t => {
    const { context } = await privateFixture(t, records());
    await seedRetainedReply(context, inventedSource(), "The lab results show a steady recovery.");
    const base = createSearchRetrieval(context, { source: inventedSource, modelDirectory, onInvalidate: () => {} });
    const enhanced = createSearchRetrieval(context, { source: inventedSource, modelDirectory, linguisticsDirectory: directory, onInvalidate: () => {} });
    t.after(() => base.close()); t.after(() => enhanced.close());
    assert.equal((await base.build()).mode, "hybrid");
    const built = await enhanced.build();
    assert.equal(built.mode, "hybrid"); assert.equal(built.linguistics.state, "ready");
    const old = reader(base), read = reader(enhanced);
    for (const expectation of originalExpectations) for (const [name, search] of [["default", old], ["optional", read]]) {
        await t.test(name + ": " + expectation.query, async () => {
            const strict = await search(expectation.query), discovery = await search(expectation.query, ["interaction"], true);
            assert.deepEqual(discovery.hits, strict.hits, "Discovery Matches must equal the complete strict result.");
            assert.ok(discovery.related.hits.every(hit => !strict.hits.some(match => match.id === hit.id)));
            assertSearchPopulation(targetIndices(strict.hits), expectation);
            assert.ok(strict.hits.every(hit => !Object.hasOwn(hit, "intent")), "Parsed intent is not disclosed.");
            if (name === "optional" && expectation.must.includes(1)) {
                assert.equal(strict.hits.find(hit => hit.target.href === "#request?request=search-1").excerpt, prompts[1]);
            }
        });
    }
    for (const [query, types] of [
        ["repair", ["interaction"]],
        ["doctor calendar GET /me/calendarView 403", ["action"]],
        ["POST /me/calendarView 403", ["action"]],
        ["GET /me/imaginaryResource 599", ["action"]],
        ["workiq-fetc", ["tool"]],
    ]) {
        await t.test("retained exact-control parity: " + query, async () => {
            assert.deepEqual((await read(query, types)).hits.map(hit => hit.id), (await old(query, types)).hits.map(hit => hit.id));
        });
    }
    t.diagnostic(JSON.stringify({ build: built.metrics, linguisticMemory: enhanced.status().linguistics }));
});
test("role-bound additions do not drop negative scope, uncertainty, ownership or location relations", resourceTest, async () => {
    const files = await readSearchLinguistics(directory);
    const { default: nlp } = await import(`data:text/javascript;base64,${files["compromise/builds/three/compromise-three.mjs"].toString("base64")}`);
    const engine = createSearchIntent(nlp, createWordNet(files));
    const original = engine.parse(prompts[1], "record");
    for (const [query, text] of [
        ["Do not find the car repair and the building where it happened.", prompts[1]],
        ["Find no car repair and the building where it happened.", prompts[1]],
        ["fix Alice's car", prompts[1]],
        ["Find the car repair and the building where it happened.", "The mechanic almost repaired a broken automobile in the garage."],
        ["Find the car repair and the building where it happened.", "The mechanic repaired a broken automobile near the garage."],
        ["fix my car", "The mechanic did not repair a broken automobile in the garage."],
    ]) assert.equal(engine.matches(engine.parse(query, "query"), engine.parse(text, "record")), false, query + " / " + text);
    assert.equal(engine.matches(engine.parse("fix my car", "query"), original), true);
    const parsed = engine.parse(prompts[1], "record");
    parsed.operation.end = prompts[1].length + 1;
    assert.equal(validSearchIntent(parsed, prompts[1]), false);
});

test("raw noun scope retains genuine negatives and independently requires the original positives", resourceTest, async t => {
    const files = await readSearchLinguistics(directory);
    const { default: nlp } = await import(`data:text/javascript;base64,${files["compromise/builds/three/compromise-three.mjs"].toString("base64")}`);
    const engine = createSearchIntent(nlp, createWordNet(files));
    for (const [query, text] of [
        ["fix my car", "The mechanic repaired no broken automobile in the garage."],
        ["fix my car", "The mechanic repaired zero automobiles in the garage."],
        ["fix my car", "Nobody repaired a broken automobile in the garage."],
        ["fix my car", "Nothing repaired a broken automobile in the garage."],
        ["fix no car", prompts[1]],
        ["fix the building", "The mechanic repaired a broken automobile near the garage."],
        ["fix the building", "The mechanic repaired a broken automobile outside the garage."],
        ["fix the pipe", "The plumber repaired a valve beside the pipe."],
        ["fix my car", "The mechanic repaired a toy automobile in the garage."],
        ["Find the car repair and the building where it happened.",
            "The mechanic repaired a broken automobile; the physician treated a patient in the garage."],
    ]) await t.test("forbidden: " + query + " / " + text, () => {
        assert.equal(engine.matches(engine.parse(query, "query"), engine.parse(text, "record")), false);
    });
    for (const [query, text] of rawRequiredPairs) await t.test("required: " + query + " / " + text, () => {
        assert.equal(engine.matches(engine.parse(query, "query"), engine.parse(text, "record")), true);
    });
});

test("actual corpus additions preserve raw negative and place-role contrasts without changing baseline hits", resourceTest, async t => {
    const texts = [prompts[1],
        "The mechanic repaired no broken automobile in the garage.",
        "The mechanic repaired zero automobiles in the garage.",
        "Nobody repaired a broken automobile in the garage.",
        "The mechanic repaired a broken automobile near the garage.",
        "The mechanic repaired a toy automobile in the garage.",
        "The plumber repaired a valve beside the pipe.",
        "The mechanic repaired a broken automobile; the physician treated a patient in the garage.",
    ];
    const rows = records(texts.length).map((row, i) => ({ ...row, scenarioId: `contrast-${i}`, userPrompt: {
        text: texts[i], status: "full", provenance: "human-authored",
    } }));
    const { context } = await privateFixture(t, rows);
    const base = createSearchRetrieval(context, { source: inventedSource, modelDirectory, onInvalidate: () => {} });
    const enhanced = createSearchRetrieval(context, { source: inventedSource, modelDirectory,
        linguisticsDirectory: directory, onInvalidate: () => {} });
    t.after(() => base.close()); t.after(() => enhanced.close());
    assert.equal((await base.build()).mode, "hybrid");
    assert.equal((await enhanced.build()).mode, "hybrid");
    const old = reader(base), read = reader(enhanced);
    for (const [query, additions] of [
        ["fix my car", [0, 4]], ["Find the car repair and the building where it happened.", [0]],
        ["fix no car", []], ["fix the building", []], ["fix the pipe", []],
    ]) await t.test(query, async () => {
        const original = (await old(query)).hits, actual = (await read(query)).hits;
        const expected = new Set([...original.map(hit => hit.target.href), ...additions.map(id => `#request?request=contrast-${id}`)]);
        assert.deepEqual(new Set(actual.map(hit => hit.target.href)), expected, query);
        for (const hit of original) assert.deepEqual(actual.find(value => value.id === hit.id), hit);
    });
});

test("qualification: ordinary-work recall cannot pass with an empty required population", resourceTest, async t => {
    const rows = records(ordinaryDocuments.length).map((row, i) => ({
        ...row, userPrompt: { ...row.userPrompt, text: ordinaryDocuments[i] },
    }));
    const { context } = await privateFixture(t, rows);
    const base = createSearchRetrieval(context, { source: inventedSource, modelDirectory, onInvalidate: () => {} });
    const enhanced = createSearchRetrieval(context, { source: inventedSource, modelDirectory,
        linguisticsDirectory: directory, onInvalidate: () => {} });
    t.after(() => base.close()); t.after(() => enhanced.close());
    assert.equal((await base.build()).mode, "hybrid");
    assert.equal((await enhanced.build()).mode, "hybrid");
    const old = reader(base), read = reader(enhanced);
    for (const expectation of ordinaryExpectations) for (const [name, search] of [["default", old], ["optional", read]]) {
        await t.test(name + ": " + expectation.query, async () => {
            assertSearchPopulation(targetIndices((await search(expectation.query)).hits), expectation);
        });
    }
});

test("linguistic query supersession, source revocation and build cancellation never disclose stale parsed records", resourceTest, async t => {
    const { context } = await privateFixture(t, records());
    await seedRetainedReply(context, inventedSource());
    let source = inventedSource(), entered;
    const engine = createSearchRetrieval(context, { source: () => source, modelDirectory, linguisticsDirectory: directory,
        onInvalidate: () => {}, onLinguisticsActivity: event => { if (event.state === "computed") entered?.resolve(); } });
    t.after(() => engine.close());
    assert.equal((await engine.build()).mode, "hybrid");
    entered = Promise.withResolvers();
    let oldDisclosed = false;
    const old = engine.search({ query: "fix my car", requestId: 0 }, () => { oldDisclosed = true; });
    await entered.promise;
    let replacement;
    const latest = engine.search({ query: "workiq-fetch", requestId: 1, types: ["tool"] }, hits => { replacement = hits; });
    assert.equal((await old).state, "superseded");
    await latest;
    assert.equal(oldDisclosed, false); assert.equal(replacement[0].title, "workiq-fetch");
    entered = Promise.withResolvers();
    const revoked = engine.search({ query: "fix my car", requestId: 2 }, () => assert.fail("Revoked source disclosed"));
    await entered.promise;
    source = { available: false, sourceConfigRef: null, sourceConfigRevision: 0 };
    assert.equal((await revoked).state, "stale");
    assert.equal(engine.status().items, 0);
    source = inventedSource();
    entered = Promise.withResolvers();
    const rebuilding = engine.build();
    await entered.promise;
    engine.invalidate();
    assert.equal((await rebuilding).state, "superseded");
    assert.equal(engine.status().items, 0);
    assert.equal((await engine.build()).mode, "hybrid");
    let hits;
    await engine.search({ query: "fix my car", requestId: 3, types: ["interaction"] }, value => { hits = value; });
    assert.deepEqual(hits.map(hit => hit.target.href), ["#request?request=search-1"]);
    entered = Promise.withResolvers();
    const closing = engine.search({ query: "fix my car", requestId: 4 }, () => assert.fail("Closed helper disclosed"));
    await entered.promise;
    await engine.close();
    assert.equal((await closing).state, "closed");
    assert.equal(engine.status().linguistics.state, "closed");
});

test("configured missing or corrupt linguistic resources fail explicitly without an implicit acquisition", resourceTest, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wire-linguistic-integrity-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { context } = await privateFixture(t, records(1));
    const missing = createSearchRetrieval(context, { source: inventedSource, modelDirectory,
        linguisticsDirectory: path.join(root, "absent"), onInvalidate: () => {} });
    t.after(() => missing.close());
    const degraded = await missing.build();
    assert.equal(degraded.mode, "lexical-only");
    assert.equal(degraded.model.code, "linguistics-missing");
    assert.equal((await reader(missing)("workiq-fetch", ["tool"])).hits[0].match, "exact");
    await missing.close();
    const copy = path.join(root, "corrupt");
    for (const spec of SEARCH_LINGUISTICS.files) {
        const target = path.join(copy, ...spec.name.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(path.join(directory, ...spec.name.split("/")), target);
    }
    await writeFile(path.join(copy, "compromise", "builds", "three", "compromise-three.mjs"), "CORRUPT");
    const corrupt = createSearchLinguistics({ directory: copy });
    t.after(() => corrupt.close());
    await assert.rejects(corrupt.prepare([]), error => error.code === "linguistics-corrupt");
    const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("Existing resource verification must never reacquire"));
    assert.equal((await provisionSearchLinguistics(directory)).enabled, false);
    await assert.rejects(provisionSearchLinguistics(copy), error => error.code === "linguistics-corrupt");
    fetch.mock.restore();
});

test("contrast inventory: allowed-only probes are not positive recall qualification", resourceTest, async t => {
    const helper = createSearchLinguistics({ directory });
    t.after(() => helper.close());
    for (const { name, documents: texts, expectations } of contrastInventories) {
        const source = texts.map((text, i) => ({ id: String(i), revision: searchHash(text), text }));
        const prepared = await helper.prepare(source);
        const items = prepared.map((value, i) => ({ ...source[i], intent: value.intent }));
        for (const expectation of expectations) await t.test(name + ": " + expectation.query, async () => {
            const hits = await helper.match(expectation.query, items), actual = hits.map(hit => Number(hit.id));
            if (expectation.must === null) {
                assert.ok(actual.every(id => expectation.allowed.includes(id)), "Forbidden contrast addition");
                t.diagnostic("Recall acceptance unspecified; this check cannot establish a positive match.");
            } else assertSearchPopulation(actual, expectation);
        });
    }
});

test("lexical additions remain behind frozen-content integrity and deletion fences without changing retained data", resourceTest, async t => {
    const { context } = await privateFixture(t, records(2));
    const exports = createExportController(context), initial = await loadBoardState(context);
    const preview = await exports.preview("lexical-fixture", undefined, { promptMode: "original", formats: ["json"] },
        { kind: "all", revision: initial.revision });
    await exports.review("lexical-fixture", preview.previewId, true);
    const artifact = (await exports.confirm("lexical-fixture", preview.previewId, true)).bundle;
    const path = artifact.files["product-report.json"], original = await readFile(path);
    const before = await loadBoardState(context);
    const engine = createSearchRetrieval(context, { source: inventedSource, modelDirectory, linguisticsDirectory: directory, onInvalidate: () => {} });
    t.after(() => engine.close());
    await engine.build();
    const read = reader(engine);
    assert.deepEqual((await read("fix my car")).hits.map(hit => hit.target.href), ["#request?request=search-1"]);
    const after = await loadBoardState(context);
    assert.deepEqual(after, before);
    assert.deepEqual(await readFile(path), original);
    await writeFile(path, "INVENTED_CORRUPT_JSON");
    const stale = await engine.search({ query: "fix my car", requestId: 1 }, () => assert.fail("Tampered corpus disclosed a cached lexical hit"));
    assert.equal(stale.state, "stale");
    assert.equal(engine.status().items, 0);
    await writeFile(path, original);
    await engine.build();
    const deletion = createDeletionController(context, { describeSavedArtifact: createSavedArtifactDescriptor(context),
        onSeal: () => engine.invalidate() });
    const removal = await deletion.previewArtifact("lexical-fixture", { artifactKind: "report", artifactId: artifact.bundleId });
    await deletion.confirmArtifact("lexical-fixture", { operationId: removal.operationId, confirmed: true });
    assert.equal(engine.status().items, 0);
    await engine.build();
    let result;
    await engine.discover({ query: "Saved report", requestId: 2, types: ["report"] }, value => { result = value; });
    assert.deepEqual(result.matches.hits, []);
    assert.deepEqual(result.related.hits, []);
});
