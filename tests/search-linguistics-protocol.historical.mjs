import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { createSearchLinguistics } from "../lib/search-linguistics.mjs";
import { SEARCH_INTENT_POLICY_ID, SEARCH_LINGUISTICS, readSearchLinguistics } from "../lib/search-linguistics-assets.mjs";
import { SEARCH_MATCH_POLICY_ID, SEARCH_RELATED, SEARCH_LEXICAL_POLICIES, SEARCH_TYPES } from "../lib/search-ranking.mjs";
import { SEARCH_MODEL_ID } from "../lib/search-model-assets.mjs";
import { createSearchWireContract, searchWireContract } from "../lib/search-wire-contract.mjs";
import { provisionSearchLinguistics } from "../scripts/provision-search-linguistics.mjs";
import { privateFixture } from "./helpers.mjs";

test("malformed owned linguistic responses reject, close, and never disclose partial results", async t => {
    const children = [];
    const stamp = { policyId: SEARCH_INTENT_POLICY_ID, ok: true, ms: 1, rss: 1024, peakRss: 1024 };
    let response;
    class OwnedChild extends EventEmitter {
        killed = false;
        send(message, callback) {
            queueMicrotask(() => {
                if (this.killed) return;
                this.emit("message", message.kind === "initialize" ? { ...stamp, kind: "ready" } : response);
                callback?.(null);
            });
        }
        kill() {
            if (this.killed) return;
            this.killed = true;
            queueMicrotask(() => this.emit("close"));
        }
    }
    const mocked = t.mock.method(childProcess, "fork", () => {
        const child = new OwnedChild();
        children.push(child);
        return child;
    });
    syncBuiltinESMExports();
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    const input = [{ id: "invented", revision: "1".repeat(64), text: "Complete original text." }];
    for (const malformed of [null, [], { ...stamp, policyId: "private" }, { ...stamp, ok: 1 },
        { ...stamp, ms: -1 }, { ...stamp, peakRss: 1 }, { ...stamp, kind: "prepared", items: [null] },
        { ...stamp, kind: "prepared", items: [{ ...input[0], intent: { policyId: "private" } }] }]) {
        response = malformed;
        const helper = createSearchLinguistics({ directory: "owned-controlled-input" });
        try { await assert.rejects(helper.prepare(input), { code: "linguistics-protocol" }); }
        finally { await helper.close(); }
    }
    for (const hits of [[null], [{ id: "outside", revision: input[0].revision }],
        [{ id: input[0].id, revision: "2".repeat(64) }], [input[0], input[0]]]) {
        response = { ...stamp, kind: "matched", hits };
        const helper = createSearchLinguistics({ directory: "owned-controlled-input" });
        try { await assert.rejects(helper.match("Find original text", input), { code: "linguistics-protocol" }); }
        finally { await helper.close(); }
    }
    assert.ok(children.every(child => child.killed));
});

test("baseline and opt-in wire identities remain explicit, distinct, closed and serializable", () => {
    const expectedRelated = {
        version: "related-navigation-minilm-original-projection-v3", modelId: SEARCH_MODEL_ID,
        strictPolicy: { version: "exact-prefix-cosine-complete-denial-v4", semanticFloor: 0.5 }, floor: 0.35, band: 0.02,
        selection: "related=remaining non-strict anchor/type-eligible scores>=floor and within band of strongest eligible score; no topN",
        purpose: "navigate-only", indexProjection: "unchanged title/content/source", noMembership: true,
    };
    const relatedId = createHash("sha256").update(JSON.stringify(expectedRelated)).digest("hex");
    assert.equal(relatedId, "68e7bbeb045c2e7c9cd5c8a1ab90dd89981ae4aecd79e1cd69e2432f9666c424");
    assert.deepEqual(SEARCH_RELATED, { ...expectedRelated, id: relatedId });
    assert.notEqual(SEARCH_LEXICAL_POLICIES.matchPolicyId, SEARCH_MATCH_POLICY_ID);
    const factory = new Function("return (" + createSearchWireContract.toString() + ")")();
    const baseline = factory({ matchPolicyId: SEARCH_MATCH_POLICY_ID, relatedPolicyId: SEARCH_RELATED.id, types: SEARCH_TYPES });
    const enabled = factory({ matchPolicyId: SEARCH_MATCH_POLICY_ID, relatedPolicyId: SEARCH_RELATED.id,
        types: SEARCH_TYPES, lexicalPolicies: SEARCH_LEXICAL_POLICIES });
    const receipt = { schemaVersion: 2, panelId: "00000000-0000-0000-0000-000000000000", epoch: 0, requestId: 0,
        generation: 1, indexId: "1".repeat(64), modelId: "2".repeat(64), mode: "hybrid", revision: 1,
        queryPurpose: "analysis", queryTypes: [...searchWireContract.allTypes], purpose: "strict-match-population",
        matchPolicyId: SEARCH_MATCH_POLICY_ID };
    const extended = { ...receipt, matchPolicyId: SEARCH_LEXICAL_POLICIES.matchPolicyId };
    assert.equal(baseline.analysisReceipt(receipt), true);
    assert.equal(baseline.analysisReceipt(extended), false);
    for (const contract of [baseline, enabled, searchWireContract]) {
        assert.equal(contract.analysisReceipt(receipt), true);
        for (const matchPolicyId of [undefined, null, "", "private", "0".repeat(64)]) {
            assert.equal(contract.validReceipt({ ...receipt, matchPolicyId }), false);
        }
        assert.equal(contract.sameReceipt(receipt, extended), false);
    }
    assert.equal(enabled.analysisReceipt(extended), true);
    assert.equal(searchWireContract.analysisReceipt(extended), true);
});

test("controlled incomplete provisioning fails closed without leaving files or activating search", async t => {
    const { root } = await privateFixture(t, []);
    const before = await readdir(root), directory = path.join(root, "resources");
    let calls = 0;
    t.mock.method(globalThis, "fetch", (url, options) => {
        calls++;
        assert.equal(String(url), SEARCH_LINGUISTICS.files[0].url);
        assert.equal(options.redirect, "error");
        assert.equal(options.credentials, "omit");
        return new Response("not-the-pinned-parser");
    });
    await assert.rejects(provisionSearchLinguistics(directory), { code: "linguistics-provision-integrity" });
    assert.equal(calls, 1);
    assert.deepEqual(await readdir(root), before);
    assert.equal(createSearchLinguistics().enabled, false);
});

test("controlled provisioning writes only approved bytes; deletion never silently reacquires", {
    skip: !process.env.WIRE_SEARCH_LINGUISTICS_TEST_DIRECTORY,
}, async t => {
    const files = await readSearchLinguistics(process.env.WIRE_SEARCH_LINGUISTICS_TEST_DIRECTORY);
    const { root } = await privateFixture(t, []), directory = path.join(root, "resources");
    const calls = [];
    t.mock.method(globalThis, "fetch", (url, options) => {
        const spec = SEARCH_LINGUISTICS.files.find(spec => spec.url === String(url));
        assert.ok(spec);
        assert.equal(options.redirect, "error");
        calls.push(spec.name);
        return new Response(files[spec.name]);
    });
    assert.equal((await provisionSearchLinguistics(directory)).enabled, false);
    assert.deepEqual(calls, SEARCH_LINGUISTICS.files.map(spec => spec.name));
    assert.deepEqual(await readSearchLinguistics(directory), files);
    await provisionSearchLinguistics(directory);
    assert.equal(calls.length, 10);
    await rm(path.join(directory, "wordnet-db", "dict", "data.verb"));
    await assert.rejects(provisionSearchLinguistics(directory), { code: "linguistics-missing" });
    assert.equal(calls.length, 10);
    assert.equal(createSearchLinguistics().enabled, false);
});
