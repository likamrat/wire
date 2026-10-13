import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { createSearchRetrieval } from "../lib/search-retrieval.mjs";
import { createSearchCorpus } from "../lib/search-corpus.mjs";
import { SEARCH_RELATED, SEARCH_RANKING, SEARCH_MATCH_POLICY_ID, SEARCH_TYPES, rankSearch, rankDiscovery, lexicalMatch } from "../lib/search-ranking.mjs";
import { SEARCH_MODEL_ID, searchHash } from "../lib/search-model-assets.mjs";
import { SEARCH_CHUNKER } from "../lib/search-chunks.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { createExportController } from "../lib/export.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { createSavedArtifactDescriptor } from "../lib/report-artifacts.mjs";
import { privateFixture } from "./helpers.mjs";
import { searchRecords } from "./live-search-fixture.mjs";
import { inventedSource, seedRetainedReply } from "./search-corpus-fixture.mjs";

const prompts = [
    "The physician treated an injured patient in the hospital.",
    "The mechanic repaired a broken automobile in the garage.",
    "Employees cannot sign in because their credentials have expired.",
    "The hospital maintenance crew repaired an ambulance engine in the garage.",
    "The clinician scheduled a follow-up visit after the patient's recovery.",
    "The support engineer renewed a revoked service account credential used by automated deployments.",
    "The event planner booked a room for a quarterly staffing discussion.",
    "The warehouse technician repaired a broken conveyor while collecting damaged components.",
    "The researcher compared medical privacy policies without handling a patient's treatment.",
];
function records(texts = prompts, label = "acceptance") {
    return searchRecords(texts.length).map((record, i) => ({
        ...record, sourceSessionName: `Invented ${label} conversation ${i}`,
        userPrompt: { ...record.userPrompt, text: texts[i] }, followUpPrompts: [],
    }));
}
function reader(engine) {
    let requestId = 0;
    return async (query, types = [], method = "discover") => {
        let result, receipt;
        const status = await engine[method]({ query, requestId: requestId++, types }, (value, stamp) => { result = value; receipt = stamp; });
        return { result, receipt, status };
    };
}
const targetIndices = hits => hits.map(hit => Number(new URLSearchParams(hit.target.href.split("?")[1]).get("request").split("-")[1]));
const deferred = () => Promise.withResolvers();

// Frozen pre-discovery strict algorithm. Parity covers the complete ranked shape, not merely counts.
function originalStrict(items, query, queryChunks, types) {
    const hits = [], allowed = new Set(types);
    const prefixes = [...new Set(items.filter(item => item.type === "tool").flatMap(item =>
        item.title.normalize("NFKC").toLowerCase().match(/^[\p{L}\p{N}]+[-_]/u) ?? []))];
    for (const item of items) {
        if (allowed.size && !allowed.has(item.type)) continue;
        const lexical = lexicalMatch(query, item, prefixes);
        if (lexical.blocked) continue;
        let similarity = -1, best = null;
        for (const chunk of item.chunks) for (const needle of queryChunks) {
            let value = 0;
            for (let i = 0; i < 384; i++) value += chunk.vector[i] * needle.vector[i];
            if (value > similarity) { similarity = value; best = chunk; }
        }
        if (!lexical.tier && similarity < 0.5) continue;
        if (lexical.tier) best = item.chunks.find(chunk =>
            lexicalMatch(query, { title: "", text: item.text.slice(chunk.start, chunk.end) }).tier > 0) ?? best;
        hits.push({ id: item.id, revision: item.revision, tier: lexical.tier, similarity,
            start: best?.start ?? 0, end: best?.end ?? item.text.length,
            match: lexical.tier >= 2 ? "exact" : lexical.tier ? "prefix" : "semantic" });
    }
    return hits.sort((a, b) => b.tier - a.tier || b.similarity - a.similarity
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : a.start - b.start));
}

test("shared discovery scoring preserves frozen strict ranking and applies type/anchor gates before its strongest score", async () => {
    assert.equal(SEARCH_RELATED.id, "1544a5093a15a386fa06361c344aabda392a5df77ad97cb1159ec87959637148");
    assert.deepEqual(SEARCH_RANKING, { version: "exact-prefix-cosine-v2", semanticFloor: 0.5 });
    assert.equal(SEARCH_MATCH_POLICY_ID, searchHash(JSON.stringify(SEARCH_RANKING)));
    const vector = score => { const value = new Float32Array(384); value[0] = score; value[1] = Math.sqrt(1 - score ** 2); return value; };
    const queryChunks = [{ vector: vector(1) }];
    const item = (id, type, title, text, score) => ({ id, revision: "invented", type, title, text,
        chunks: [{ start: 0, end: text.length, vector: vector(score) }] });
    const items = [
        item("tool", "tool", "workiq-fetch", "workiq-fetch", 0.7),
        item("exact", "action", "Recorded action", "GET /me/calendarView 403", 0.1),
        item("near-a", "action", "Recorded action", "GET /me/calendarView 403\nExpired credentials", 0.4),
        item("near-b", "action", "Recorded action", "GET /me/calendarView 403\nCredentials rejected", 0.39),
        item("distant", "action", "Recorded action", "GET /me/calendarView 403\nWeak topic", 0.36),
        item("conflict", "action", "Recorded action", "POST /me/calendarView 403", 0.9),
        item("other-type", "report", "Saved report", "GET /me/calendarView 403", 0.95),
    ];
    for (const query of ["workiq-fetch", "workiq-fet", "GET /me/calendarView 403", "GET /me/calendarView 403 authentication failure", "GET /absent 599"]) {
        for (const types of [[], ["action"], ["tool"]]) {
            const expected = originalStrict(items, query, queryChunks, types);
            assert.deepEqual(await rankSearch(items, query, queryChunks, types, new AbortController().signal), expected);
            assert.deepEqual((await rankDiscovery(items, query, queryChunks, types, new AbortController().signal)).matches, expected);
        }
    }
    const result = await rankDiscovery(items, "GET /me/calendarView 403 authentication failure", queryChunks, ["action"], new AbortController().signal);
    assert.deepEqual(result.related.map(hit => hit.id), ["near-a", "near-b"]);
    assert.equal(result.evaluatedItems, 4);
    const strong = item("strict-semantic", "action", "Recorded action", "GET /me/calendarView 403\nAuthentication unavailable", 0.7);
    const suppressed = await rankDiscovery([...items, strong], "GET /me/calendarView 403 authentication failure", queryChunks, ["action"], new AbortController().signal);
    assert.equal(suppressed.matches[0].id, strong.id); assert.deepEqual(suppressed.related, []);
    assert.deepEqual((await rankDiscovery(items, "unknown", [], [], new AbortController().signal)).related, []);
});

test("real MiniLM discover finds the three navigation targets with unchanged strict items/excerpts/index and one query inference", async t => {
    const { context } = await privateFixture(t, records());
    let computed = 0, sourceReads = 0;
    const engine = createSearchRetrieval(context, { source: () => { sourceReads++; return inventedSource(); }, onInvalidate: () => {},
        onModelActivity: event => { if (event.state === "computed") computed++; } });
    t.after(() => engine.close());
    const built = await engine.build(), read = reader(engine);
    const corpus = createSearchCorpus(context, { source: inventedSource, onInvalidate: () => {} });
    let expectedIdentity;
    await corpus.index(entries => entries.map(item => [item.id, item.revision]), (items, receipt) => {
        expectedIdentity = searchHash(JSON.stringify([SEARCH_MODEL_ID, SEARCH_CHUNKER, SEARCH_RANKING, "hybrid", receipt.generation, items]));
    });
    corpus.close();
    assert.equal(built.indexId, expectedIdentity, "Discovery policy must not enter the strict index identity");
    const before = JSON.stringify(await loadBoardState(context));
    const cases = [
        ["fix my car", [1]], ["vehicle servicing", [3, 1]],
        ["Find the car repair and the building where it happened.", [1]],
    ];
    for (const [query, related] of cases) {
        const start = computed, reads = sourceReads;
        const { result, status } = await read(query, ["interaction"]);
        const discoveryReads = sourceReads - reads;
        assert.equal(computed - start, 1);
        assert.deepEqual(targetIndices(result.related.hits), related);
        assert.deepEqual(result.matches.hits, []);
        assert.equal(status.count, 0); assert.equal(status.related.count, related.length);
        assert.notEqual(status.state, "no-match");
        assert.equal(result.related.receipt.relatedPolicyId, SEARCH_RELATED.id);
        assert.equal(result.matches.receipt.matchPolicyId, SEARCH_MATCH_POLICY_ID);
        assert.deepEqual(result.matches.receipt.types, ["interaction"]);
        assert.equal(result.related.coverage.populationComplete, false);
        assert.equal(result.related.coverage.evaluatedItems, 9);
        assert.equal(result.related.receipt.indexId, expectedIdentity);
        assert.ok(result.related.hits.every(hit => hit.match === "related" && hit.purpose === "navigate-only" && !Object.hasOwn(hit, "similarity")));
        assert.ok(result.related.hits.some(hit => hit.excerpt.includes("The mechanic repaired a broken automobile in the garage.")));
        assert.ok(Object.isFrozen(result.related.receipt.types)); assert.ok(Object.isFrozen(result.matches.hits));
        const strictReads = sourceReads;
        assert.deepEqual((await read(query, ["interaction"], "search")).result, []);
        assert.equal(sourceReads - strictReads, discoveryReads, "Discovery must use one corpus delivery, not independent gates for both sets");
    }
    for (const query of ["A doctor cared for somebody who was hurt.", "People could not log in with an out-of-date password.", "repair", "GET /me/calendarView 403"]) {
        const strict = await read(query, [], "search"), discovery = await read(query);
        assert.deepEqual(discovery.result.matches.hits, strict.result);
        const { purpose, matchPolicyId, types, ...base } = discovery.result.matches.receipt;
        assert.equal(purpose, "strict-match-population");
        assert.deepEqual({ ...base, requestId: strict.receipt.requestId }, strict.receipt);
        assert.deepEqual(types, SEARCH_TYPES);
    }
    for (const query of ["Distant galaxies contain enormous black holes.", "A recipe for chocolate cake and vanilla icing.",
        "A hospital accountant calculated quarterly payroll.", "doctor GET /me/calendarView 599", "POST /me/calendarView 403", "GET /me/imaginaryResource 599"]) {
        const { result } = await read(query, query.includes("/") ? ["action"] : ["interaction"]);
        assert.deepEqual(result.matches.hits, []); assert.deepEqual(result.related.hits, []);
    }
    const blankStart = computed, empty = await read("");
    assert.equal(computed, blankStart); assert.deepEqual(empty.result.matches.hits, []); assert.deepEqual(empty.result.related.hits, []);
    assert.equal(empty.result.related.coverage.evaluatedItems, 0);
    const canonical = (await read("workiq-fetch", ["tool", "interaction", "tool"])).result;
    assert.deepEqual(canonical.matches.receipt.types, ["interaction", "tool"]);
    assert.deepEqual(canonical.related.receipt.types, canonical.matches.receipt.types);
    await assert.rejects(engine.discover({ query: "x", requestId: 1000, types: ["invented"] }, () => {}), TypeError);
    assert.equal(JSON.stringify(await loadBoardState(context)), before);
});

test("held-out Related discovery improves finding records without changing near-intent strict membership or adding unrelated noise", async t => {
    const documents = [
        "The engineer restored the deleted database from yesterday's backup.",
        "The engineer rotated database passwords before deleting an old backup.",
        "The operations team increased the application's memory limit after it kept crashing.",
        "The analyst reviewed memory pricing while the application remained stable.",
        "The accountant reconciled an overdue vendor invoice with a missing bank transfer.",
        "The accountant prepared an estimate for next year's supplier budget.",
        "The technician replaced a frayed network cable to reconnect the office printer.",
        "The designer ordered ink for an office printer brochure.",
        "The administrator revoked a departed employee's access to the shared folder.",
        "The administrator restored an active employee's access after a password reset.",
        "The recruiter moved an interview to Friday because the candidate was unavailable.",
        "The recruiter wrote feedback from a completed interview.",
    ];
    const { context } = await privateFixture(t, records(documents, "heldout"));
    const engine = createSearchRetrieval(context, { source: inventedSource, onInvalidate: () => {} });
    t.after(() => engine.close());
    await engine.build(); const read = reader(engine);
    for (const [query, wanted] of [["recover lost records", 0], ["stop the app running out of RAM", 2],
        ["late supplier payment", 4], ["get the printer back online", 6], ["reschedule a job interview", 10]]) {
        const discovery = (await read(query, ["interaction"])).result;
        assert.ok([...discovery.matches.hits, ...discovery.related.hits].some(hit => targetIndices([hit])[0] === wanted));
        assert.deepEqual(discovery.matches.hits, (await read(query, ["interaction"], "search")).result);
    }
    const missed = (await read("remove permissions after someone leaves", ["interaction"])).result;
    assert.deepEqual(missed.matches.hits, []); assert.deepEqual(missed.related.hits, []);
    for (const [query, target] of [["replace printer toner", 6], ["recover deleted documents from the shared folder", 8]]) {
        const result = (await read(query, ["interaction"])).result;
        assert.deepEqual(result.matches.hits, []);
        assert.deepEqual(targetIndices(result.related.hits), [target]);
        assert.equal(result.related.receipt.purpose, "related-navigation");
    }
    for (const query of ["orbital trajectories of distant comets", "bake a sourdough loaf with rye flour",
        "the rules of an international chess tournament", "how dolphins navigate deep ocean currents"]) {
        const result = (await read(query, ["interaction"])).result;
        assert.deepEqual(result.matches.hits, []); assert.deepEqual(result.related.hits, []);
    }
});

test("120 unrelated retained records do not crowd out or pad the three qualified navigation queries", async t => {
    const noise = ["The astronomer plotted a comet trajectory.", "The baker adjusted a sourdough bread recipe.",
        "The historian catalogued medieval letters.", "The violinist rehearsed a concerto.", "The chemist compared noble gases.",
        "The sailor checked the weather forecast.", "The geologist examined volcanic minerals.", "The athlete trained for a sprint.",
        "The painter mixed pigments for a portrait.", "The chess club announced its tournament.", "The translator annotated an ancient poem.",
        "The biologist recorded dolphin calls."];
    const documents = [...prompts, ...Array.from({ length: 10 }, () => noise).flat()];
    const { context } = await privateFixture(t, records(documents));
    const engine = createSearchRetrieval(context, { source: inventedSource, onInvalidate: () => {} });
    t.after(() => engine.close());
    await engine.build(); const read = reader(engine);
    for (const query of ["fix my car", "vehicle servicing", "Find the car repair and the building where it happened."]) {
        const result = (await read(query, ["interaction"])).result;
        assert.ok(targetIndices(result.related.hits).includes(1));
        assert.ok(targetIndices(result.related.hits).every(i => [1, 3].includes(i)));
    }
    const result = (await read("purple teleportation for interstellar unicorns", ["interaction"])).result;
    assert.deepEqual(result.matches.hits, []); assert.deepEqual(result.related.hits, []);
});

test("Related all-candidate coverage retains 63 distinct IDs, deterministic ties and strict emptiness", async t => {
    const rows = records(Array.from({ length: 63 }, () => prompts[1]));
    for (const row of rows) row.sourceSessionName = "Invented acceptance conversation 1";
    const { context } = await privateFixture(t, rows);
    const engine = createSearchRetrieval(context, { source: inventedSource, onInvalidate: () => {} });
    t.after(() => engine.close());
    await engine.build();
    const read = reader(engine), first = (await read("fix my car", ["interaction"])).result;
    assert.equal(first.related.hits.length, 63); assert.deepEqual(first.matches.hits, []);
    const ids = first.related.hits.map(hit => hit.id);
    assert.equal(new Set(ids).size, 63); assert.deepEqual(ids, [...ids].sort());
    const pages = Array.from({ length: 4 }, (_, page) => first.related.hits.slice(page * 20, (page + 1) * 20));
    assert.deepEqual(pages.flat().map(hit => hit.id), ids);
    const repeated = (await read("fix my car", ["interaction"])).result;
    assert.deepEqual(repeated.related.hits, first.related.hits);
    assert.equal(repeated.related.receipt.indexId, first.related.receipt.indexId);
});

test("discover and strict search share supersession, source revocation, build changes and close", async t => {
    const { context } = await privateFixture(t, records().slice(0, 3));
    await seedRetainedReply(context);
    let source = inventedSource(), entered;
    const engine = createSearchRetrieval(context, { source: () => source, onInvalidate: () => {},
        onModelActivity: event => { if (event.state === "computed") entered?.resolve(); } });
    t.after(() => engine.close());
    await engine.build();
    let requestId = 0, late = false;
    for (const [oldMethod, nextMethod] of [["discover", "search"], ["search", "discover"]]) {
        entered = deferred();
        const old = engine[oldMethod]({ query: "Invented research and vehicle material. ".repeat(1500), requestId: requestId++ }, () => { late = true; });
        await entered.promise;
        let latest;
        const next = engine[nextMethod]({ query: "workiq-fetch", requestId: requestId++, types: ["tool"] }, value => { latest = value; });
        assert.equal((await old).state, "superseded");
        await next; assert.equal(late, false);
        assert.equal(nextMethod === "discover" ? latest.matches.hits.length : latest.length, 1);
    }
    assert.equal((await engine.discover({ query: "old", requestId: 0 }, () => assert.fail())).state, "superseded");
    entered = deferred();
    const revoke = engine.discover({ query: "retained reply", requestId: requestId++ }, () => assert.fail("Revoked union cannot disclose"));
    await entered.promise;
    source = { available: false, sourceConfigRef: null, sourceConfigRevision: 0 };
    const denied = await revoke;
    assert.equal(denied.related.state, "unavailable"); assert.equal(engine.status().items, 0);
    await engine.build();
    entered = deferred();
    const changing = engine.discover({ query: "Invented material. ".repeat(1500), requestId: requestId++ }, () => assert.fail());
    await entered.promise;
    const rebuilding = engine.build();
    assert.equal((await changing).state, "superseded"); await rebuilding;
    entered = deferred();
    const closing = engine.discover({ query: "Invented material. ".repeat(1500), requestId: requestId++ }, () => assert.fail());
    await entered.promise;
    await engine.close();
    assert.equal((await closing).state, "closed");
});

test("unavailable models never claim Related availability and asynchronous disclosure cannot succeed", async t => {
    const { root, context } = await privateFixture(t, records().slice(0, 1));
    const modelDirectory = path.join(root, "bad-model");
    await mkdir(modelDirectory);
    await writeFile(path.join(modelDirectory, "config.json"), Buffer.alloc(650));
    const engine = createSearchRetrieval(context, { source: inventedSource, modelDirectory, onInvalidate: () => {} });
    t.after(() => engine.close());
    assert.equal((await engine.build()).mode, "lexical-only");
    let result;
    const status = await engine.discover({ query: "workiq-fetch", requestId: 0 }, value => { result = value; });
    assert.ok(result.matches.hits.length);
    assert.equal(result.related.state, "unavailable"); assert.equal(result.related.reason, "model-unavailable");
    assert.deepEqual(result.related.hits, []); assert.equal(result.related.receipt, null);
    assert.equal(status.related.state, "unavailable");
    const asyncResult = await engine.discover({ query: "workiq-fetch", requestId: 1 }, () => Promise.resolve());
    assert.equal(asyncResult.related.state, "unavailable"); assert.equal(engine.status().items, 0);
    assert.ok((await readdir(context.dataDir)).every(name => !/search|query|index/.test(name)));
    const missing = createSearchRetrieval(context, { source: inventedSource, modelDirectory: path.join(root, "missing-model"), onInvalidate: () => {} });
    try {
        assert.equal((await missing.build()).model.code, "model-missing");
        await missing.discover({ query: "workiq-fetch", requestId: 0 }, value => { result = value; });
        assert.equal(result.related.state, "unavailable"); assert.equal(result.related.receipt, null);
        assert.ok(result.matches.hits.length);
    } finally { await missing.close(); }
});

test("one authorized union delivery prevents both lists leaking modified or deleted frozen artifacts", async t => {
    const { context } = await privateFixture(t, records().slice(0, 2));
    const exports = createExportController(context), state = await loadBoardState(context);
    const preview = await exports.preview("discover-proof", undefined, { promptMode: "original", formats: ["json"] },
        { kind: "all", revision: state.revision });
    await exports.review("discover-proof", preview.previewId, true);
    const saved = (await exports.confirm("discover-proof", preview.previewId, true)).bundle;
    const original = await readFile(saved.files["product-report.json"]);
    let entered, rawChild, sends = 0;
    const originalFork = childProcess.fork;
    const mocked = t.mock.method(childProcess, "fork", (modulePath, args, options) => {
        const child = originalFork(modulePath, args, options);
        if (String(modulePath).endsWith("search-model-worker.mjs")) {
            rawChild = child;
            const send = child.send.bind(child);
            child.send = (message, ...rest) => { if (message.kind === "embed") sends++; return send(message, ...rest); };
        }
        return child;
    });
    syncBuiltinESMExports();
    const engine = createSearchRetrieval(context, { source: inventedSource, onInvalidate: () => {},
        onModelActivity: event => { if (event.state === "computed") entered?.resolve(); } });
    try {
        await engine.build();
        let result, calls = 0;
        const started = sends;
        await engine.discover({ query: "vehicle servicing", requestId: 0 }, value => { result = value; calls++; });
        assert.equal(sends - started, 1); assert.equal(calls, 1);
        assert.ok(result.related.hits.length);
        entered = deferred();
        const pending = engine.discover({ query: "Saved report", requestId: 1 }, () => assert.fail("Corrupt union must not disclose"));
        await entered.promise;
        await writeFile(saved.files["product-report.json"], "INVENTED_CORRUPT_JSON");
        assert.equal((await pending).related.state, "unavailable");
        assert.equal(engine.status().items, 0);
        await writeFile(saved.files["product-report.json"], original);
        await engine.build();
        const deletion = createDeletionController(context, { describeSavedArtifact: createSavedArtifactDescriptor(context),
            onSeal: () => engine.invalidate() });
        const removal = await deletion.previewArtifact("discover-proof", { artifactKind: "report", artifactId: saved.bundleId });
        await deletion.confirmArtifact("discover-proof", { operationId: removal.operationId, confirmed: true });
        assert.equal(engine.status().items, 0);
        await engine.build();
        await engine.discover({ query: "Saved report", types: ["report"], requestId: 2 }, value => { result = value; });
        assert.deepEqual(result.matches.hits, []); assert.deepEqual(result.related.hits, []);
    } finally {
        await engine.close(); mocked.mock.restore(); syncBuiltinESMExports();
        assert.ok(!rawChild || rawChild.exitCode !== null || rawChild.signalCode !== null);
    }
});
