import test from "node:test";
import assert from "node:assert/strict";
import { adaptCoworkSourceRecords, adaptCoworkSourceRecordsWithMessageParts,
    COWORK_PARTS_ADAPTER_VERSION } from "../lib/cowork-source-adapter.mjs";
import { projectNativeReadModel } from "../lib/native-read-model.mjs";
import { textFindings } from "../lib/privacy.mjs";
import { coworkSourceContext, sourceObservation } from "./cowork-source-adapter-fixtures.mjs";

const credentialExample = '{"password":"EXAMPLE_ONLY"}';
const start = inp => sourceObservation({ id: "privacy-start", event: "ts",
    data: { tid: "privacy-call", tn: "mcp__outlook__MoveMessage", inp } });

test("decoded credential-assignment string is excluded from both native carrier and actual projected input", () => {
    assert.equal(textFindings(credentialExample).some(finding => finding.mandatory), true);
    const source = start({ query: credentialExample }), before = structuredClone(source);
    const envelopes = adaptCoworkSourceRecords([source], coworkSourceContext());
    const projected = projectNativeReadModel(envelopes);
    const input = projected.conversations[0].calls[0].observations[0].fields.input;
    assert.equal(input.availability, "credential-excluded");
    assert.equal(Object.hasOwn(input, "value"), false);
    assert.equal(Object.hasOwn(envelopes[0].record.data, "inp"), false);
    assert.equal(Object.hasOwn(envelopes[0].qualifiedFields.input, "value"), false);
    assert.doesNotMatch(JSON.stringify([envelopes, projected]), /EXAMPLE_ONLY/);
    assert.deepEqual(source, before);
});

test("root, array and nested decoded strings plus serialized credential structure are all screened", () => {
    const inputs = [
        `Literal ${credentialExample}`,
        JSON.stringify(credentialExample),
        [credentialExample],
        { outer: [{ inner: credentialExample }] },
        JSON.stringify({ outer: [{ inner: credentialExample }] }),
        { password: "EXAMPLE_ONLY" },
        JSON.stringify({ password: "EXAMPLE_ONLY" }),
    ];
    for (const [index, inp] of inputs.entries()) {
        const observation = start(inp);
        const envelopes = adaptCoworkSourceRecords([observation], coworkSourceContext());
        const model = projectNativeReadModel(envelopes), carrier = envelopes[0].record.data;
        const fact = model.conversations[0].calls[0].observations[0].fields.input;
        assert.equal(fact.availability, "credential-excluded", `input case ${index}`);
        assert.equal(fact.reason, "credential-bearing-source-field");
        assert.equal(Object.hasOwn(fact, "value"), false);
        assert.equal(Object.hasOwn(carrier, "inp"), false);
        assert.deepEqual(fact.evidence, [{
            sourceDocument: "invented-response", pointer: "/messages/0/data/inp", nativeEventId: "privacy-start",
        }]);
        assert.doesNotMatch(JSON.stringify([envelopes, model]), /EXAMPLE_ONLY/);
        assert.equal(model.conversations[0].calls[0].outcome.state, "unknown");
        assert.equal(model.admission.admitted, false);
    }
});

test("benign root/array/nested strings preserve original input encoding and existing null/empty/absent semantics", () => {
    const inputs = [
        { source: "a plain question", expected: "a plain question" },
        { source: 'Literal {"topic":"reading"}', expected: 'Literal {"topic":"reading"}' },
        { source: JSON.stringify('{"topic":"reading"}'), expected: '{"topic":"reading"}' },
        { source: ['{"topic":"reading"}'], expected: ['{"topic":"reading"}'] },
        { source: { query: '{"topic":"reading"}', limit: 0 }, expected: { query: '{"topic":"reading"}', limit: 0 } },
        { source: '{"query":"{\\"topic\\":\\"reading\\"}","limit":0}', expected: { query: '{"topic":"reading"}', limit: 0 } },
        { source: "password", expected: "password" },
        { source: [0, false, null, ""], expected: [0, false, null, ""] },
        { source: { count: 2, enabled: false }, expected: { count: 2, enabled: false } },
    ];
    for (const { source, expected } of inputs) {
        const observation = start(source), before = structuredClone(observation);
        const envelopes = adaptCoworkSourceRecords([observation], coworkSourceContext());
        const fact = projectNativeReadModel(envelopes).conversations[0].calls[0].observations[0].fields.input;
        assert.equal(fact.availability, "recorded");
        assert.deepEqual(fact.value, expected);
        assert.deepEqual(envelopes[0].record.data.inp, source);
        assert.deepEqual(observation, before);
    }
    for (const [inp, availability] of [[null, "explicit-null"], ["", "recorded-empty"]]) {
        const envelopes = adaptCoworkSourceRecords([start(inp)], coworkSourceContext());
        assert.equal(envelopes[0].qualifiedFields.input.availability, availability);
        assert.equal(envelopes[0].record.data.inp, inp);
    }
    const missing = start(null);
    delete missing.record.data.inp;
    const absent = adaptCoworkSourceRecords([missing], coworkSourceContext())[0].qualifiedFields.input;
    assert.equal(absent.availability, "absent-in-response");
    assert.equal(absent.reason, "field-absent-from-read-response");
});

test("privacy screening keeps the existing preflight guards and never executes accessors or recursively parses text", () => {
    let invoked = false;
    const accessor = start({});
    Object.defineProperty(accessor.record.data.inp, "query", { enumerable: true, get() { invoked = true; return credentialExample; } });
    assert.throws(() => adaptCoworkSourceRecords([accessor], coworkSourceContext()), { code: "non-json-accessor" });
    assert.equal(invoked, false);
    const cyclic = {};
    cyclic.self = cyclic;
    assert.throws(() => adaptCoworkSourceRecords([start(cyclic)], coworkSourceContext()), { code: "non-json-input" });
    const deep = "[".repeat(65) + "0" + "]".repeat(65);
    assert.throws(() => adaptCoworkSourceRecords([start(deep)], coworkSourceContext()), { code: "json-structure-bound" });
    const nestedText = { query: deep };
    const envelopes = adaptCoworkSourceRecords([start(nestedText)], coworkSourceContext());
    assert.deepEqual(envelopes[0].qualifiedFields.input.value, nestedText);
});

test("explicit v4 also excludes nested input from its carrier and shared multipart projection", () => {
    const context = coworkSourceContext();
    context.capture.parserVersion = COWORK_PARTS_ADAPTER_VERSION;
    for (const inp of [`Literal ${credentialExample}`, [credentialExample], { query: credentialExample },
        JSON.stringify({ outer: [credentialExample] })]) {
        const envelopes = adaptCoworkSourceRecordsWithMessageParts([start(inp)], context);
        const model = projectNativeReadModel(envelopes);
        assert.equal(envelopes[0].qualifiedFields.input.availability, "credential-excluded");
        assert.equal(Object.hasOwn(envelopes[0].record.data, "inp"), false);
        assert.equal(model.conversations[0].calls[0].observations[0].fields.input.availability, "credential-excluded");
        assert.doesNotMatch(JSON.stringify([envelopes, model]), /EXAMPLE_ONLY/);
        assert.equal(model.admission.admitted, false);
    }
    const benign = { query: '{"topic":"reading"}' };
    assert.deepEqual(adaptCoworkSourceRecordsWithMessageParts([start(benign)], context)[0].qualifiedFields.input.value, benign);
});
