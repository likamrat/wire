import test from "node:test";
import assert from "node:assert/strict";
import * as native from "../lib/native-read-model.mjs";
import { coworkFixture, recorded } from "./native-read-model-fixtures.mjs";
import { TEXT_RULES, CREDENTIAL_CATEGORIES, findCredentialFindings, findTextFindings } from "../lib/privacy-text.mjs";

test("native credential checks do not execute optional disclosure patterns", t => {
    const optionalCalls = [];
    const optionalRules = new Map(TEXT_RULES.filter(([category]) => !CREDENTIAL_CATEGORIES.includes(category))
        .map(([category, rule]) => [rule, category]));
    const original = String.prototype.matchAll;
    t.mock.method(String.prototype, "matchAll", function (rule) {
        if (optionalRules.has(rule)) optionalCalls.push(optionalRules.get(rule));
        return original.call(this, rule);
    });
    assert.equal(native.nativeValueHasCredentials({ query: "ordinary text", endpoint: "https://example.test" }), false);
    assert.deepEqual(optionalCalls, []);
});

test("mandatory-only findings preserve the full scanner's exact categories, offsets and ordering", () => {
    const examples = [
        "", "ordinary reader@example.test", JSON.stringify(coworkFixture()),
        '{"password":"EXAMPLE_ONLY"}',
        "Bearer " + "x".repeat(24),
        "https://reader:EXAMPLE_ONLY@example.test",
        "-----BEGIN PRIVATE KEY-----\nEXAMPLE ONLY\n-----END PRIVATE KEY-----",
    ];
    for (const text of [...examples, examples.join("\n")]) {
        assert.deepEqual(findCredentialFindings(text), findTextFindings(text).filter(finding => finding.mandatory));
    }
    assert.ok(findTextFindings("reader@example.test").some(finding => finding.category === "email_identifiers"));
});

test("the shared projector rejects a credential assignment in a decoded input string leaf", () => {
    const row = coworkFixture().find(item => item.record.event === "ts");
    const value = { query: '{"password":"EXAMPLE_ONLY"}' };
    row.record.data.inp = value;
    row.qualifiedFields.input = recorded(value);
    assert.throws(() => native.projectNativeReadModel([row]),
        error => error instanceof native.NativeReadModelError && error.code === "credential-bearing-fact");
});

test("the bounded helper checks serialized structure and decoded leaves without parsing arbitrary text", () => {
    const assignment = '{"password":"EXAMPLE_ONLY"}';
    for (const value of [
        { password: "EXAMPLE_ONLY" }, assignment, [assignment],
        { nested: [{ query: assignment }] }, { [assignment]: "ordinary" },
    ]) assert.equal(native.nativeValueHasCredentials(value), true);
    const benign = { query: "[".repeat(65) + "0" + "]".repeat(65), nested: [null, false, "ordinary"] };
    const before = structuredClone(benign);
    assert.equal(native.nativeValueHasCredentials(benign), false);
    assert.deepEqual(benign, before);
    const row = coworkFixture().find(item => item.record.event === "ts");
    row.record.data.inp = benign;
    row.qualifiedFields.input = recorded(benign);
    assert.deepEqual(native.projectNativeReadModel([row]).conversations[0].calls[0].observations[0].fields.input.value, benign);
});

test("serialized credential URLs cannot be assembled across independent JSON string tokens", () => {
    const independent = [{ url: "https://example.test" }, { contact: "reader@example.test" }];
    for (const value of independent) assert.equal(native.nativeValueHasCredentials(value), false);
    assert.equal(native.nativeValueHasCredentials(independent), false);
    assert.equal(native.nativeValueHasCredentials({ nested: independent }), false);
    assert.equal(native.nativeValueHasCredentials({ "https://example.test": "reader@example.test" }), false);
    assert.equal(native.nativeValueHasCredentials([{ url: 'https://example.test?q="quoted"' }, independent[1]]), false);
});

test("URL boundary screening preserves mandatory decoded text, field names and structural assignments", () => {
    const url = "https://reader:EXAMPLE_ONLY@example.test";
    for (const value of [
        url, { url }, { [url]: "ordinary" },
        [{ url: "https://example.test" }, { contact: "reader@example.test" }, { url }],
        { url: 'https://reader:EXAMPLE"ONLY@example.test' },
        { url: "https://reader:EXAMPLE\\ONLY@example.test" },
        { url: "https://reader:EXAMPLE_ONLY@example.test", token: "EXAMPLE_ONLY" },
        { password: "EXAMPLE_ONLY" }, { token: "EXAMPLE_ONLY" },
        { query: '{"password":"EXAMPLE_ONLY"}' },
    ]) assert.equal(native.nativeValueHasCredentials(value), true);
});

test("excluded or omitted facts do not excuse an unsafe minimal carrier", () => {
    for (const omitted of [false, true]) {
        const row = coworkFixture().find(item => item.record.event === "ts");
        row.record.data.inp = JSON.stringify({ query: '{"password":"EXAMPLE_ONLY"}' });
        if (omitted) delete row.qualifiedFields.input;
        else row.qualifiedFields.input = { availability: "credential-excluded", reason: "native-input-credential-excluded" };
        assert.throws(() => native.projectNativeReadModel([row]),
            error => error instanceof native.NativeReadModelError && error.code === "credential-bearing-native-carrier");
    }
    const cleaned = coworkFixture().find(item => item.record.event === "ts");
    delete cleaned.record.data.inp;
    cleaned.qualifiedFields.input = { availability: "credential-excluded", reason: "native-input-credential-excluded" };
    const result = native.projectNativeReadModel([cleaned]);
    assert.equal(result.conversations[0].calls[0].observations[0].fields.input.availability, "credential-excluded");
    assert.equal(Object.hasOwn(result.conversations[0].calls[0].observations[0].fields.input, "value"), false);
});

test("the existing native root-input decode is screened without changing its interpretation", () => {
    const row = coworkFixture().find(item => item.record.event === "ts");
    const encoded = JSON.stringify({ query: '{"password":"EXAMPLE_ONLY"}' });
    row.record.data.inp = encoded;
    row.qualifiedFields.input = recorded(encoded);
    assert.throws(() => native.projectNativeReadModel([row]),
        error => error instanceof native.NativeReadModelError && error.code === "credential-bearing-fact");
});

test("privacy scanning preserves bounded JSON rejection before invoking any accessor", () => {
    let invoked = false;
    const value = Object.defineProperty({}, "query", { enumerable: true, get() { invoked = true; return "ordinary"; } });
    assert.throws(() => native.nativeValueHasCredentials(value),
        error => error instanceof native.NativeReadModelError && error.code === "non-json-accessor");
    assert.equal(invoked, false);
    const cycle = {}; cycle.child = cycle;
    assert.throws(() => native.nativeValueHasCredentials(cycle), native.NativeReadModelError);
});
