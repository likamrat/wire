import test from "node:test";
import assert from "node:assert/strict";
import { createSearchLinguistics } from "../lib/search-linguistics.mjs";
import { createSearchModel } from "../lib/search-model.mjs";
import { createSearchRetrieval } from "../lib/search-retrieval.mjs";
import { SEARCH_RANKING, SEARCH_MATCH_POLICY_ID, SEARCH_RELATED, SEARCH_LEXICAL_POLICIES, lexicalMatch } from "../lib/search-ranking.mjs";
import { searchHash } from "../lib/search-model-assets.mjs";
import { searchWireContract } from "../lib/search-wire-contract.mjs";
import { permittedSearchText } from "../lib/search-chunks.mjs";
import { privateFixture, fixture } from "./helpers.mjs";
import { inventedSource } from "./search-corpus-fixture.mjs";

const directory = process.env.WIRE_SEARCH_LINGUISTICS_TEST_DIRECTORY;
const modelDirectory = process.env.WIRE_SEARCH_MODEL_TEST_DIRECTORY;
const resourceTest = { skip: !directory, timeout: 120000 };
const regressions = [
    { query: "do not fix my car", text: "The mechanic did not patch an automobile in the garage.", polarity: "negative" },
    { query: "fix my car", text: "The mechanic repaired a fake automobile in the garage.", qualifier: "fake" },
];
const sourceItem = (text, index = 0) => ({ id: `scope-${index}`, revision: searchHash(text), text });
const target = hit => hit.target.href;

test("scope correction preserves baseline policy identities and invalidates the unsafe opt-in policy", () => {
    assert.equal(SEARCH_MATCH_POLICY_ID, "077699b2dc5542dc983fde41e4f56c4b4be90deebc763492fa61191440365b6f");
    assert.equal(SEARCH_RELATED.id, "1544a5093a15a386fa06361c344aabda392a5df77ad97cb1159ec87959637148");
    const receipt = { schemaVersion: 2, panelId: "00000000-0000-0000-0000-000000000000", epoch: 0, requestId: 0,
        generation: 1, indexId: "1".repeat(64), modelId: "2".repeat(64), mode: "hybrid", revision: 1,
        queryPurpose: "analysis", queryTypes: [...searchWireContract.allTypes], purpose: "strict-match-population",
        matchPolicyId: SEARCH_LEXICAL_POLICIES.matchPolicyId };
    assert.equal(searchWireContract.analysisReceipt(receipt), true);
    assert.equal(searchWireContract.analysisReceipt({ ...receipt,
        matchPolicyId: "5b0d27bfc3d7c7257751e8618ab967a0bad160166613bbecf4fe1a22607fc674" }), false);
    assert.equal(searchWireContract.analysisReceipt({ ...receipt, matchPolicyId: SEARCH_MATCH_POLICY_ID }), true);
});

test("production linguistic helper rejects the reviewed negative-generalization and modifier-loss admissions", resourceTest, async t => {
    const helper = createSearchLinguistics({ directory });
    const model = createSearchModel({ directory: modelDirectory });
    t.after(() => helper.close()); t.after(() => model.close());
    for (const [index, item] of regressions.entries()) {
        await t.test(item.query + " / " + item.text, async () => {
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
            assert.ok(cosine < SEARCH_RANKING.semanticFloor, "Canonical baseline must exclude the reproduced wrong admission");
            const hits = await helper.match(item.query, [{ ...source, intent: prepared.intent }]);
            t.diagnostic(JSON.stringify({ query: item.query, canonical, cosine, lexical, helperIds: hits.map(hit => hit.id) }));
            assert.deepEqual(hits, [], item.query + " / " + item.text);
        });
    }
});

test("scope restrictions are generic across operations, arguments, locations and source modifiers", resourceTest, async t => {
    const helper = createSearchLinguistics({ directory });
    t.after(() => helper.close());
    const cases = [
        ["do not fix my car", "The mechanic did not repair an automobile in the garage."],
        ["do not repair my vehicle", "The mechanic did not repair a car."],
        ["do not fix the pipe", "The plumber did not patch the pipe in the building."],
        ["do not fix the pipe", "The plumber did not repair the pipe."],
        ["fix my car", "The mechanic repaired an imaginary automobile in the garage."],
        ["fix my car", "The mechanic repaired a miniature automobile in the garage."],
        ["fix my car", "The mechanic repaired a red automobile in the garage."],
        ["fix my car", "The mechanic repaired a broken automobile in the garage."],
        ["Find the car repair and the building where it happened.", "The mechanic repaired a broken automobile in the garage."],
        ["fix the pipe", "The plumber repaired a fake pipe in the building."],
        ["fix the pipe", "The plumber repaired a broken pipe in the building."],
        ["fix my car", "The fictional mechanic repaired an automobile in the garage."],
        ["fix my car", "The mechanic repaired an automobile in an imaginary garage."],
        ["fix the fake vehicle", "The mechanic repaired a fake automobile in the garage."],
    ];
    for (const [query, text] of cases) {
        const source = sourceItem(text), [prepared] = await helper.prepare([source]);
        assert.equal(prepared.intent.state, "supported", query + " / " + text);
        assert.deepEqual(await helper.match(query, [{ ...source, intent: prepared.intent }]), [], query + " / " + text);
    }
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

test("actual retrieval excludes scope-unsafe additions but preserves every complete baseline result", resourceTest, async t => {
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
            expected.add("#request?request=scope-5");
        }
        assert.deepEqual(new Set(actual.map(target)), expected, query);
        for (const hit of original) assert.deepEqual(actual.find(candidate => candidate.id === hit.id), hit);
        t.diagnostic(JSON.stringify({ query, baselineIds: original.map(hit => hit.id), acceptedIds: actual.map(hit => hit.id) }));
    }
});
