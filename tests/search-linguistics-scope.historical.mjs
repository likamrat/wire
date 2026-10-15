import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSearchLinguistics } from "../lib/search-linguistics.mjs";
import { createSearchModel } from "../lib/search-model.mjs";
import { createSearchRetrieval } from "../lib/search-retrieval.mjs";
import { SEARCH_RANKING, SEARCH_MATCH_POLICY_ID, SEARCH_RELATED, SEARCH_LEXICAL_POLICIES, lexicalMatch } from "../lib/search-ranking.mjs";
import { SEARCH_MODEL_ID, searchHash } from "../lib/search-model-assets.mjs";
import { searchWireContract } from "../lib/search-wire-contract.mjs";
import { permittedSearchText } from "../lib/search-chunks.mjs";
import { privateFixture, fixture } from "./helpers.mjs";
import { inventedSource } from "./search-corpus-fixture.mjs";
import { scopeCases, assertSearchPopulation } from "./search-linguistics-fixture.mjs";

const directory = process.env.WIRE_SEARCH_LINGUISTICS_TEST_DIRECTORY;
const modelDirectory = process.env.WIRE_SEARCH_MODEL_TEST_DIRECTORY;
const resourceTest = { skip: !directory, timeout: 120000 };
const regressions = [
    { query: "do not fix my car", text: "The mechanic did not patch an automobile in the garage.", polarity: "negative",
        authority: "mechanism-observation" },
    { query: "fix my car", text: "The mechanic repaired a fake automobile in the garage.", qualifier: "fake",
        authority: "primary-negative-contrast" },
];
const sourceItem = (text, index = 0) => ({ id: `scope-${index}`, revision: searchHash(text), text });
const target = hit => hit.target.href;

test("current strict policy binds denial correction and invalidates older receipt policies", () => {
    assert.equal(SEARCH_MATCH_POLICY_ID, "7a1856ac8d53036a49501aaf0e9631a621c381b5338ec757762b9af0342f9b7c");
    const expectedRelated = {
        version: "related-navigation-minilm-original-projection-v3", modelId: SEARCH_MODEL_ID,
        strictPolicy: { version: "exact-prefix-cosine-complete-denial-v4", semanticFloor: 0.5 }, floor: 0.35, band: 0.02,
        selection: "related=remaining non-strict anchor/type-eligible scores>=floor and within band of strongest eligible score; no topN",
        purpose: "navigate-only", indexProjection: "unchanged title/content/source", noMembership: true,
    };
    const relatedId = createHash("sha256").update(JSON.stringify(expectedRelated)).digest("hex");
    assert.equal(relatedId, "68e7bbeb045c2e7c9cd5c8a1ab90dd89981ae4aecd79e1cd69e2432f9666c424");
    assert.deepEqual(SEARCH_RELATED, { ...expectedRelated, id: relatedId });
    const receipt = { schemaVersion: 2, panelId: "00000000-0000-0000-0000-000000000000", epoch: 0, requestId: 0,
        generation: 1, indexId: "1".repeat(64), modelId: "2".repeat(64), mode: "hybrid", revision: 1,
        queryPurpose: "analysis", queryTypes: [...searchWireContract.allTypes], purpose: "strict-match-population",
        matchPolicyId: SEARCH_LEXICAL_POLICIES.matchPolicyId };
    assert.equal(searchWireContract.analysisReceipt(receipt), true);
    assert.equal(searchWireContract.analysisReceipt({ ...receipt,
        matchPolicyId: "5b0d27bfc3d7c7257751e8618ab967a0bad160166613bbecf4fe1a22607fc674" }), false);
    assert.equal(searchWireContract.analysisReceipt({ ...receipt, matchPolicyId: SEARCH_MATCH_POLICY_ID }), true);
    assert.equal(searchWireContract.analysisReceipt({ ...receipt,
        matchPolicyId: "077699b2dc5542dc983fde41e4f56c4b4be90deebc763492fa61191440365b6f" }), false);
    assert.equal(searchWireContract.analysisReceipt({ ...receipt,
        matchPolicyId: "f16ede3a34199db95881d843f6ef84aeb24b9b578b54ff349420361bf5ea26da" }), false);
});

test("reviewed admission regressions distinguish mechanism abstention from a genuine fake-object negative", resourceTest, async t => {
    const helper = createSearchLinguistics({ directory });
    const model = createSearchModel({ directory: modelDirectory });
    t.after(() => helper.close()); t.after(() => model.close());
    for (const [index, item] of regressions.entries()) {
        await t.test(item.authority + ": " + item.query + " / " + item.text, async () => {
            const source = sourceItem(item.text, index);
            const [prepared] = await helper.prepare([source]);
            assert.equal(prepared.intent.state, "supported", "Do not hide a matching defect behind a broken parse");
            if (item.polarity) assert.equal(prepared.intent.polarity, item.polarity);
            if (item.qualifier) assert.ok(prepared.intent.arguments.some(argument => argument.qualifiers.includes(item.qualifier)));
            const canonical = permittedSearchText({ title: "Recorded request", content: item.text,
                source: { label: `Invented acceptance conversation ${index}` } });
            const itemChunks = await model.embed(canonical), queryChunks = await model.embed(item.query);
            let cosine = -1;
            for (const passage of itemChunks) for (const query of queryChunks) {
                let score = 0;
                for (let i = 0; i < 384; i++) score += passage.vector[i] * query.vector[i];
                cosine = Math.max(cosine, score);
            }
            const lexical = lexicalMatch(item.query, { title: "Recorded request", text: canonical });
            assert.equal(lexical.tier, 0);
            assert.equal(lexical.blocked, false);
            assert.ok(cosine < SEARCH_RANKING.semanticFloor, "Retain the observed canonical baseline exclusion.");
            const hits = await helper.match(item.query, [{ ...source, intent: prepared.intent }]);
            t.diagnostic(JSON.stringify({ query: item.query, canonical, cosine, lexical, helperIds: hits.map(hit => hit.id) }));
            assert.deepEqual(hits, [], item.query + " / " + item.text);
        });
    }
});

test("scope checks retain genuine negatives and separately document current fail-closed mechanism behavior", resourceTest, async t => {
    const helper = createSearchLinguistics({ directory });
    t.after(() => helper.close());
    for (const group of scopeCases) for (const [query, text] of group.pairs) await t.test(group.authority + ": " + query + " / " + text, async () => {
        const source = sourceItem(text), [prepared] = await helper.prepare([source]);
        assert.equal(prepared.intent.state, "supported", query + " / " + text);
        const hits = await helper.match(query, [{ ...source, intent: prepared.intent }]);
        if (group.authority === "primary-negative-contrast") assertSearchPopulation(hits.map(hit => hit.id), { ...group, query });
        else assert.deepEqual(hits, [], "Current mechanism abstains; this is not a permanent semantic prohibition.");
    });
    for (const [query, text] of [
        ["fix my car", "The mechanic repaired an automobile in the garage."],
        ["fix the pipe", "The plumber repaired the pipe in the building."],
        ["fix the fake automobile", "The mechanic repaired a fake automobile in the garage."],
        ["fix the broken pipe", "The plumber repaired a broken pipe in the building."],
    ]) {
        const source = sourceItem(text), [prepared] = await helper.prepare([source]);
        assert.deepEqual(await helper.match(query, [{ ...source, intent: prepared.intent }]),
            [{ id: source.id, revision: source.revision }], query + " / " + text);
    }
});

test("actual retrieval retains mechanism parity and required positives, not permanent bans on unsupported forms", resourceTest, async t => {
    const texts = [...regressions.map(item => item.text),
        "The plumber did not patch a pipe in the building.",
        "The plumber repaired an imaginary pipe in the building.",
        "The mechanic repaired a broken automobile in the garage.",
        "The mechanic repaired an automobile in the garage.",
        "The physician treated an injured patient in the hospital.",
    ];
    const records = texts.map((text, index) => {
        const record = fixture(`scope-${index}`);
        record.userPrompt.text = text; record.followUpPrompts = [];
        record.sourceSessionName = `Invented acceptance conversation ${index}`;
        return record;
    });
    const { context } = await privateFixture(t, records);
    const base = createSearchRetrieval(context, { source: inventedSource, modelDirectory, onInvalidate: () => {} });
    const enhanced = createSearchRetrieval(context, { source: inventedSource, modelDirectory,
        linguisticsDirectory: directory, onInvalidate: () => {} });
    t.after(() => base.close()); t.after(() => enhanced.close());
    assert.equal((await base.build()).mode, "hybrid");
    assert.equal((await enhanced.build()).mode, "hybrid");
    let requestId = 0;
    for (const query of ["do not fix my car", "do not fix the pipe", "fix my car", "fix the pipe", "automobile",
        "A doctor cared for somebody who was hurt.",
        "Find the car repair and the building where it happened."]) {
        const input = { query, types: ["interaction"], requestId: requestId++ };
        let original, actual;
        await base.search(input, hits => { original = hits; });
        await enhanced.search(input, hits => { actual = hits; });
        assert.ok(original && actual);
        const expected = new Set(original.map(target));
        if (query === "fix my car" || query === "Find the car repair and the building where it happened.") {
            expected.add("#request?request=scope-4");
            expected.add("#request?request=scope-5");
        }
        assert.deepEqual(new Set(actual.map(target)), expected, query);
        for (const hit of original) assert.deepEqual(actual.find(candidate => candidate.id === hit.id), hit);
        t.diagnostic(JSON.stringify({ query, baselineIds: original.map(hit => hit.id), acceptedIds: actual.map(hit => hit.id) }));
    }
});
