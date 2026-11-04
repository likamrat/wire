import test from "node:test";
import assert from "node:assert/strict";
import { errorDiagnostic, retainedErrorDiagnostic } from "../lib/failure-details.mjs";
import { normalizeResultEvidence, resultDescription, normalizeResultDescription } from "../lib/result-evidence.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";

test("typed diagnostic punctuation survives without admitting JSON bodies or stacks", () => {
    for (const message of ["Required scope [Tasks.ReadWrite] is missing.", "[Tasks.ReadWrite] is required.",
        "Provide {taskId} before retrying.", "{taskId} is required.", "Expected [2] entries, got [1]."]) {
        const diagnostic = errorDiagnostic({ message }, "native-tool-error");
        assert.equal(diagnostic.message, message);
        assert.deepEqual(retainedErrorDiagnostic(diagnostic), diagnostic);
    }
    for (const message of ['Returned payload: {"body":"EXCLUDED_BODY"}', 'Error: {"secretField":"EXCLUDED_BODY"}',
        '["EXCLUDED_BODY"]', "Error\n at run (C:\\example\\script.js:12)", "```json\n{}\n```"]) {
        const diagnostic = errorDiagnostic({ message }, "completion-error");
        assert.equal(diagnostic.status, "unsupported-format");
        assert.equal(diagnostic.message, undefined);
    }
});

test("source descriptions use the shared text screen without becoming error diagnoses", () => {
    for (const [value, status] of [[undefined, "not-supplied"], [null, "explicit-null"], ["", "recorded-empty"],
        ["Fetched [2] recorded entries.", "recorded"], ["Contact person@example.invalid.", "redacted"],
        ["Bearer " + "x".repeat(40), "sensitive-excluded"], ["x".repeat(8193), "size-excluded"],
        [{ message: "Unsupported object" }, "unsupported-format"]]) {
        const description = resultDescription(value);
        assert.equal(description.status, status);
        assert.deepEqual(normalizeResultDescription(description), description);
        assert.equal(Object.hasOwn(description, "message"), false);
    }
    assert.equal(resultDescription("Fetched [2] recorded entries.").text, "Fetched [2] recorded entries.");
    assert.equal(resultDescription('{"body":"EXCLUDED_BODY"}').text, undefined);
});

test("shared result carrier admits only explicit facts without changing their evidence unit", () => {
    const original = { version: 1, source: "native-tool-result", applicationError: null, statusCode: null,
        resultCount: null, contentStatus: "unsupported-format" };
    assert.deepEqual(normalizeResultEvidence(original), original);
    assert.equal(normalizeResultEvidence({ ...original, contentStatus: "recorded-empty" }).contentStatus, "recorded-empty");
    assert.deepEqual(normalizeResultEvidence({ ...original, statusCode: 204, contentStatus: "explicit-null" }),
        { ...original, statusCode: 204, contentStatus: "explicit-null" });
    for (const change of [{ version: 2 }, { source: "unqualified" }, { statusCode: "204" }, { statusCode: 999 },
        { applicationError: "false" }, { resultCount: -1 }, { resultCount: 1.5 }, { contentStatus: "success" }]) {
        assert.equal(normalizeResultEvidence({ ...original, ...change }), null);
    }
    const diagnostic = errorDiagnostic({ message: "Required scope [Tasks.ReadWrite] is missing." }, "native-tool-error");
    const value = { ...original, applicationError: true, diagnostic, body: "EXCLUDED_BODY" };
    assert.deepEqual(normalizeResultEvidence(value), { ...original, applicationError: true, diagnostic });
    assert.equal(normalizeResultEvidence({ ...value, diagnostic: { version: 2 } }), null);
});

test("shared presentation keeps empty diagnostics truthful, descriptions distinct and report labels unchanged", () => {
    const shared = createRecordedResults({ screen: true });
    assert.equal(shared.labels("tool").success, "Tool completed");
    assert.equal(createRecordedResults().labels("tool").success, "Worked");
    assert.deepEqual(shared.resultDetails({ version: 1 }), []);
    assert.match(JSON.stringify(shared.diagnosticDetails({ version: 1, status: "not-supplied" })), /did not supply/);
    assert.match(JSON.stringify(shared.diagnosticDetails({ version: 1, status: "recorded", code: "failure" })), /generic failure marker/);
    assert.deepEqual(shared.diagnosticDetails({ version: 2 }), []);
    const sentinel = shared.diagnosticDetails(errorDiagnostic("failure", "native-tool-error"));
    assert.deepEqual(sentinel.find(([label]) => label === "Recorded error"), ["Recorded error", "failure"]);
    assert.match(JSON.stringify(sentinel), /no detailed cause/);
    const value = { version: 1, source: "native-tool-result", applicationError: null, statusCode: null,
        contentStatus: "recorded-empty", resultCount: null, description: resultDescription("Listed [2] recorded entries.") };
    const rows = shared.resultDetails(value);
    assert.deepEqual(rows.find(([label]) => label === "Source description"), ["Source description", "Listed [2] recorded entries."]);
    assert.ok(!rows.some(([label]) => label === "Recorded error"));
    assert.match(JSON.stringify(rows), /empty content/);
});
