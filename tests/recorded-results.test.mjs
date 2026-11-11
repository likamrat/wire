import test from "node:test";
import assert from "node:assert/strict";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { buildActivityAnalytics, buildRequestActivity } from "../lib/activity-analytics.mjs";
import { fixture } from "./helpers.mjs";
import { buildExportCatalog } from "../lib/export-selection.mjs";
import { createReportScope } from "../web/report-scope.mjs";

test("call group labels preserve retained ordinals without implying unselected calls", () => {
    const results = createRecordedResults(), input = [9, 2, 1, 2, 4, 8];
    assert.equal(results.callGroupLabel([6]), results.callLabel(6));
    assert.equal(results.callGroupLabel([1, 2, 3]), "Calls #1\u20133");
    assert.equal(results.callGroupLabel(input), "Calls #1\u20132, #4, #8\u20139");
    assert.deepEqual(input, [9, 2, 1, 2, 4, 8]);
    for (const invalid of [[], [0], [1, -2], ["2"], [1.5], [Infinity], [1, , 2], undefined]) {
        assert.throws(() => results.callGroupLabel(invalid), TypeError);
    }
});

test("screen result details preserve dynamic source-qualified units and report defaults", () => {
    let accepted = { layer: "tool", unit: "source-qualified tool calls" };
    const results = createRecordedResults({ scope: () => accepted, screen: true });
    assert.equal(results.labels("tool").success, "Tool completed");
    assert.equal(results.unit("tool", 1), "recorded tool call");
    assert.equal(results.unit("tool", 2), "recorded tool calls");
    assert.equal(results.columnUnit("tool", 2), "calls");
    assert.equal(results.countLabel("tool", 1, 2), "1 of 2 recorded tool calls matches this view");
    accepted = { layer: "reported-api", unit: "source-qualified returned-result observations" };
    assert.equal(results.unit("reported-api", 1), "recorded returned result");
    assert.equal(results.unit("reported-api", 2), "recorded returned results");
    assert.equal(results.unit("tool", 1), "Work IQ tool call");
    accepted = { layer: "tool", measurementEligibility: { nativeActivityDates: "unqualified" } };
    assert.equal(results.unit("tool", 0), "recorded tool calls");
    assert.equal(results.populationLabel("native-tool-call"), "Microsoft native tool calls");
    assert.equal(results.outcomeTitle("tool", { separateUnits: true }), "Results by source");
    assert.deepEqual(results.diagnosticDetails({ version: 1, status: "recorded", message: "Recorded diagnostic." }),
        [["Recorded error", "Recorded diagnostic."]]);
    assert.deepEqual(results.resultDetails({ version: 1, contentStatus: "explicit-null" }),
        [["Result content", "The source returned no body."]]);
    assert.equal(createRecordedResults({ scope: () => accepted }).labels("tool").success, "Worked");
});

test("result widget titles name the evidence unit without conflating source populations", () => {
    const results = createRecordedResults();
    const titles = { tool: "Tool call results", "reported-api": "Returned result statuses",
        "direct-request": "Graph request-site status", "recorded-http": "Visible Graph statuses",
        http: "HTTP record results", "code-reference": "Code references" };
    for (const [layer, title] of Object.entries(titles)) assert.equal(results.outcomeTitle(layer), title);
    for (const layer of ["tool", "reported-api"]) {
        assert.equal(results.outcomeTitle(layer, { separateUnits: true }), "Results by source");
    }
    for (const layer of ["unsupported", "__proto__", "toString"]) {
        assert.throws(() => results.outcomeTitle(layer), /supported evidence layer/);
    }
});

test("operation labels use recorded tool and canonical requested targets without inventing methods", () => {
    const results = createRecordedResults({ screen: true });
    assert.equal(results.callOperation({ tool: "workiq-ask", endpoint: { path: null } }), "workiq-ask");
    assert.equal(results.callOperation({ tool: "workiq-fetch", targets: [{ path: "/me/messages", method: null },
        { path: "/me/calendarView", method: null }] }),
    "workiq-fetch \u00b7 Requested: /me/messages; /me/calendarView");
    assert.equal(results.callOperation({ tool: "workiq-delete_entity", endpoint: { method: "DELETE", path: "/planner/plans/{id}" } }),
        "workiq-delete_entity \u00b7 Requested: DELETE /planner/plans/{id}");
});

test("a retained code cannot hide a privacy, size or format gap in the rest of the diagnostic", () => {
    const results = createRecordedResults({ screen: true });
    for (const [status, expected] of [["sensitive-excluded", "privacy"], ["size-excluded", "saving limit"], ["unsupported-format", "error format"]]) {
        const items = results.callReasonItems({ failureEvidence: { version: 1,
            diagnostic: { version: 1, source: "completion-error", code: "AccessDenied", status } } }, "failure");
        assert.ok(items.some(item => item.text.includes("AccessDenied")));
        assert.ok(items.some(item => item.text.includes(expected)));
    }
});

test("result selections canonicalize OR unions without silently broadening invalid input", () => {
    const results = createRecordedResults();
    assert.deepEqual(results.selection("unknown,success,unknown"), ["success", "unknown"]);
    assert.equal(results.filterValue("unknown,success,unknown"), "success,unknown");
    assert.equal(results.filterValue("failure"), "failure");
    assert.equal(results.filterValue("all"), undefined);
    assert.equal(results.filterValue(["success", "failure", "unknown", "partial", "other", "transport"]), undefined);
    assert.equal(results.filterValue("failure,not-a-result"), "failure,not-a-result");
    assert.equal(results.filterValue(","), ",");
});
test("a mixed request describes matching canonical actions without a request-level verdict", () => {
    const results = createRecordedResults();
    const rows = [
        { id: "call:1", outcome: "success" },
        { id: "call:2", outcome: "failure" },
        { id: "call:3", outcome: "unknown" },
    ];
    const summary = results.summarize([rows[1], rows[1]]);
    assert.deepEqual(summary, { count: 1, success: 0, failure: 1, unknown: 0, partial: 0, other: 0, transport: 0 });
    assert.equal(results.countLabel("tool", summary.count, results.summarize(rows).count), "1 of 3 Work IQ tool calls matches this view");
    assert.deepEqual(results.entries("tool", summary), [{ key: "failure", label: "Tool failed", count: 1, icon: "result-failure" }]);
});

test("failure explanations use retained signals only and stay with their canonical call subset", () => {
    const results = createRecordedResults();
    const calls = new Map([
        ["sign-in", { failureEvidence: { version: 1, reason: "error-code-recorded", code: "failure",
            messageStatus: "text-excluded", messageSignal: "workiq-sign-in-required" } }],
        ["denied", { failureEvidence: { version: 1, reason: "error-details-excluded",
            messageStatus: "text-excluded", messageSignal: "access-denial" } }],
        ["timeout", { failureEvidence: { version: 1, reason: "error-details-excluded",
            messageStatus: "text-excluded", messageSignal: "request-timeout" } }],
        ["code", { failureEvidence: { version: 1, reason: "error-code-recorded", code: "ResourceMissing" } }],
        ["private", { failureEvidence: { version: 1, reason: "error-details-excluded",
            messageStatus: "sensitive-excluded", messageSignal: "workiq-sign-in-required" } }],
        ["unknown", { requestArgs: { query: "Sign-in required" }, apiResults: [{ statusCode: 401 }] }],
        ["unretained", { failureEvidence: { version: 1, reason: "result-content-excluded", messageStatus: "text-excluded" } }],
    ]);
    assert.deepEqual([...calls.values()].map(call => results.failureReason(call)), [
        "Sign-in was required", "Access was denied", "Request timed out (MCP -32001)", "Recorded error: ResourceMissing",
        "Error text excluded for privacy", "Failure reason was not saved", "Error text was not saved",
    ]);
    const rows = [...calls.keys()].map(id => ({ id, outcome: "failure" }));
    rows.push({ id: "worked", outcome: "success" }, { id: "partial", outcome: "partial" }, { id: "not-observed", outcome: "unknown" });
    const source = row => calls.get(row.id) ?? calls.get("sign-in");
    const full = results.explainedEntries("tool", [...rows, rows[0]], source);
    assert.equal(full.reduce((sum, entry) => sum + entry.count, 0), rows.length);
    assert.equal(full.filter(entry => entry.reason === "Sign-in was required").length, 1);
    assert.ok(full.filter(entry => entry.key !== "failure").every(entry => !entry.reason));
    const filtered = results.explainedEntries("tool", rows.filter(row => row.id === "unknown"), source);
    assert.deepEqual(filtered, [{ key: "failure", label: "Tool failed", count: 1, icon: "result-failure", reason: "Failure reason was not saved" }]);
    for (const layer of results.layers.filter(layer => layer !== "tool")) {
        assert.ok(results.explainedEntries(layer, rows, source).every(entry => !entry.reason), `${layer} never borrows a tool failure cause`);
    }
    assert.deepEqual(results.explainedEntries("tool", [rows[0], { id: "sign-in-2", outcome: "failure" }],
        () => calls.get("sign-in")), [{ key: "failure", label: "Tool failed", count: 2, icon: "result-failure", reason: "Sign-in was required" }]);
    assert.equal(results.explainedEntries("tool", [rows[0], { ...rows[0], outcome: "success" }], source), null);
});

test("pure, unknown, code-only and unavailable results never invent request success", () => {
    const results = createRecordedResults();
    for (const outcome of ["success", "failure", "unknown", "partial", "other", "transport"]) {
        const summary = results.summarize([{ id: "one", outcome }]);
        assert.equal(summary.count, 1);
        assert.equal(results.entries("tool", summary)[0].count, 1);
        assert.equal(results.entries("tool", summary)[0].label, results.labels("tool")[outcome]);
    }
    assert.equal(results.summarize(undefined), null);
    assert.equal(results.summarize([{ id: "missing" }]), null);
    assert.equal(results.entries("tool", { count: 0 }), null);
    assert.match(results.countLabel("tool", 2, null), /full-request count unavailable/);
    assert.deepEqual(results.entries("code-reference", results.summarize([{ id: "ref", outcome: "unknown" }])), [{ key: "unknown", count: 1, label: "Execution not observed", icon: "unobserved" }]);
    assert.equal(results.summarize([{ id: "same", outcome: "success" }, { id: "same", outcome: "failure" }]), null);
    assert.deepEqual(results.entries("tool", results.summarize([])), []);
    for (const layer of results.layers) for (const outcome of ["success", "failure", "transport", "unknown", "partial", "other"]) {
        assert.equal(results.canInspect(layer, outcome), layer !== "code-reference" && ["success", "failure", "transport"].includes(outcome));
    }
    assert.equal(results.canInspect("unavailable", "success"), false);
});

test("Activity keeps every failure reason scoped to its canonical call", () => {
    const results = createRecordedResults();
    const rows = [
        { id: "denied", outcome: "failure" },
        { id: "worked", outcome: "success" },
        { id: "sign-in", outcome: "failure" },
        { id: "denied-again", outcome: "failure" },
        { id: "timeout", outcome: "failure" },
    ];
    const signals = { denied: "access-denial", "denied-again": "access-denial",
        "sign-in": "workiq-sign-in-required", timeout: "request-timeout" };
    const callFor = row => ({ failureEvidence: {
        version: 1, reason: "error-details-excluded", messageStatus: "text-excluded",
        messageSignal: signals[row.id],
    } });
    const presentation = results.activitySummary("tool", [...rows, rows[0]], callFor);
    assert.equal(presentation.summary.count, 5);
    assert.equal(presentation.summary.failure, 4);
    assert.equal(presentation.outcome, "failure");
    assert.deepEqual(presentation.reasons.map(({ rowId, reason, count }) => ({ rowId, reason, count })), [
        { rowId: "denied", reason: "Access was denied", count: 1 },
        { rowId: "sign-in", reason: "Sign-in was required", count: 1 },
        { rowId: "denied-again", reason: "Access was denied", count: 1 },
        { rowId: "timeout", reason: "Request timed out (MCP -32001)", count: 1 },
    ]);
    assert.equal(presentation.moreReasons, 0);
    assert.equal(results.activitySummary("tool", [rows[4]], callFor).moreReasons, 0);
    assert.deepEqual(results.activitySummary("tool", [rows[4]], callFor).reasons,
        [{ rowId: "timeout", reason: "Request timed out (MCP -32001)", count: 1, outcome: "failure", tone: "failure" }]);
});

test("screen cards retain every scoped problem after successful calls without success prose in failure reasons", () => {
    const results = createRecordedResults({ screen: true });
    const diagnostic = message => ({ version: 1, status: "recorded", message });
    const calls = [
        { resultEvidence: { version: 1, contentStatus: "body-excluded" } },
        { resultEvidence: { version: 1, statusCode: 200 } },
        { failureEvidence: { version: 1, diagnostic: diagnostic("The item is locked.") } },
        { failureEvidence: { version: 1, diagnostic: diagnostic("The service timed out.") } },
        { failureEvidence: { version: 1, diagnostic: diagnostic("The item is locked.") } },
    ];
    const rows = calls.map((_, index) => ({ id: `call-${index}`, outcome: index < 2 ? "success" : "failure" }));
    const before = structuredClone(calls);
    const summary = results.activitySummary("tool", [...rows, rows[2]], row => calls[rows.findIndex(value => value.id === row.id)]);
    assert.equal(summary.summary.count, 5);
    assert.equal(summary.summary.success, 2);
    assert.equal(summary.summary.failure, 3);
    assert.deepEqual(summary.reasons.map(value => [value.rowId, value.reason]), [
        ["call-2", "Recorded error: The item is locked."],
        ["call-3", "Recorded error: The service timed out."],
        ["call-4", "Recorded error: The item is locked."],
    ]);
    assert.equal(summary.moreReasons, 0);
    assert.deepEqual(calls, before);
});

test("all parent, structured-detail and returned error reasons survive one call presentation", () => {
    const results = createRecordedResults({ screen: true });
    const call = {
        failureEvidence: { version: 1, diagnostic: { version: 1, status: "recorded", message: "The batch failed.",
            details: [{ message: "The first prerequisite was missing." }, { message: "The second prerequisite was missing." }] } },
        apiResults: Array.from({ length: 4 }, (_, index) => ({ index, statusCode: 403,
            errorDiagnostic: { version: 1, status: "recorded", message: `Returned problem ${index + 1}.` } })),
    };
    const text = results.failureReason(call);
    for (const expected of ["The batch failed.", "The first prerequisite was missing.", "The second prerequisite was missing.",
        "Returned entry 1", "Returned entry 2", "Returned entry 3", "Returned entry 4"]) assert.ok(text.includes(expected), expected);
    assert.doesNotMatch(text, /more returned errors/);
    const completed = { ...call, failureEvidence: undefined, resultEvidence: { version: 1, applicationError: true,
        diagnostic: { version: 1, status: "recorded", message: "Application validation failed." } } };
    const summary = results.activitySummary("tool", [{ id: "completed", outcome: "success" }], () => completed);
    assert.equal(summary.summary.success, 1);
    assert.equal(summary.summary.failure, 0);
    for (const expected of ["application error", "Application validation failed.", "Returned entry 4"]) {
        assert.ok(summary.reasons[0].reason.includes(expected), expected);
    }
});

test("partial completion and code-only details keep their own facts without an invented completed verdict", () => {
    const results = createRecordedResults({ screen: true });
    const partial = { resultEvidence: { version: 1, diagnostic: { version: 1, status: "recorded",
        details: [{ code: "FirstMissing" }, { code: "SecondMissing", statusCode: 409 }] } } };
    const summary = results.activitySummary("tool", [{ id: "partial", outcome: "partial" }], () => partial);
    assert.equal(summary.summary.partial, 1);
    assert.equal(summary.summary.failure, 0);
    assert.match(summary.reasons[0].reason, /^Tool partly completed;/);
    assert.match(summary.reasons[0].reason, /FirstMissing\nSecondMissing; status 409/);
    const failure = { failureEvidence: { version: 1, diagnostic: partial.resultEvidence.diagnostic } };
    assert.equal(results.failureReason(failure), "Recorded error: FirstMissing\nSecondMissing; status 409");
    const prefix = "A repeated boundary ".repeat(5), suffix = "An unchanged diagnostic tail ".repeat(7);
    const diagnostics = { version: 1, status: "recorded", message: prefix + "FIRST distinct middle " + suffix,
        details: [{ message: prefix + "SECOND distinct middle " + suffix }] };
    const reason = results.failureReason({ failureEvidence: { version: 1, diagnostic: diagnostics } });
    assert.equal(reason.split("\n").length, 2, "Distinct full reasons must not deduplicate just because their excerpts match.");
    const completed = results.activitySummary("tool", [{ id: "completed", outcome: "success" }],
        () => ({ resultEvidence: { version: 1, statusCode: 204, diagnostic: { version: 1, status: "not-supplied" } } }));
    assert.equal(completed.outcome, "success");
    assert.equal(completed.reasons[0].reason, "Tool completed; reported status 204");
});

test("contextual explanations omit WIRE recitals but never strip the same words from source messages", () => {
    const results = createRecordedResults({ screen: true });
    const source = "Recorded error: these words came from the source.";
    const call = { failureEvidence: { version: 1, diagnostic: { version: 1, status: "recorded", message: source } },
        apiResults: [{ index: 0, statusCode: 413, errorDiagnostic: { version: 1, status: "recorded",
            message: "The download exceeds the retained limit." } }] };
    assert.equal(results.failureReason(call, { contextual: true, includeReturned: false }), source);
    assert.match(results.failureReason(call, { contextual: true }), /^Recorded error: these words came from the source\.\nReturned entry 1:/);
    assert.match(results.failureReason(call), /^Recorded error: Recorded error:/, "Default projections retain their existing contract.");
    const plain = { failureEvidence: { version: 1, diagnostic: { version: 1, status: "recorded",
        message: "Payload too large; downloads are limited to 4 MB." } } };
    assert.equal(results.activitySummary("tool", [{ id: "call", outcome: "failure" }], () => plain, { contextual: true }).reasons[0].reason,
        "Payload too large; downloads are limited to 4 MB.");
});

test("reader call summaries do not repeat errors already visible on their returned entries", () => {
    const results = createRecordedResults({ screen: true });
    const call = { resultEvidence: { version: 1, contentStatus: "body-excluded", resultCount: 2 },
        apiResults: [{ index: 0, statusCode: 200 }, { index: 1, statusCode: 403,
            errorDiagnostic: { version: 1, status: "recorded", message: "The document is restricted." } }] };
    const rows = [{ id: "call", outcome: "success" }];
    const card = results.explainedEntries("tool", rows, () => call, { contextual: true });
    assert.equal(card[0].reason, "Returned entry 2: The document is restricted. (status 403)");
    const reader = results.explainedEntries("tool", rows, () => call, { contextual: true, includeReturned: false });
    assert.equal(reader[0].reason, null);
    assert.equal(reader[0].key, "success");
    assert.equal(reader[0].count, 1);
    assert.equal(results.failureReason(call, { contextual: true, includeReturned: false }), null);
});

test("call groups combine only complete equivalent returned facts and preserve every member identity", () => {
    const results = createRecordedResults({ screen: true });
    const error = index => ({ index, statusCode: 403, evidenceLevel: "intermediary-reported",
        errorDiagnostic: { version: 1, source: "workiq-error-json", status: "recorded",
            message: "You do not have the required permissions to access this item." } });
    const call = { apiResults: [error(0), error(1), error(2), { index: 3, statusCode: 200 }, { index: 4, statusCode: 200 }] };
    const before = structuredClone(call);
    const groups = results.returnedErrorGroups(call);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].label, "Returned entries 1\u20133");
    assert.equal(groups[0].text, "You do not have the required permissions to access this item. (status 403)");
    assert.deepEqual(groups[0].offsets, [0, 1, 2]);
    assert.deepEqual(groups[0].indexes, [0, 1, 2]);
    assert.deepEqual(call, before);
    assert.equal(results.callLabel(6), "Call #6");
    assert.equal(results.callLabel(12), "Call #12");
    assert.deepEqual(results.returnedErrorGroups({ apiResults: [error(0), error(2), error(4)] })[0].label, "Returned entries 1, 3, 5");
    for (const patch of [
        { path: "/me/drive/items/another-item" }, { requestedApiPath: "/me/messages/item" },
        { evidenceLevel: "directly-observed" }, { errorCode: "OtherCode" }, { statusCode: 404 },
        { errorDiagnostic: { ...error(0).errorDiagnostic, source: "completion-error" } },
        { errorDiagnostic: { ...error(0).errorDiagnostic, details: [{ message: "A different requirement applies." }] } },
        { errorDiagnostic: { ...error(0).errorDiagnostic, status: "redacted" } },
    ]) assert.equal(results.returnedErrorGroups({ apiResults: [error(0), { ...error(1), ...patch }] }).length, 2, JSON.stringify(patch));
    for (const status of ["redacted", "size-excluded", "unsupported-format"]) {
        const entry = { ...error(0), errorDiagnostic: { ...error(0).errorDiagnostic, status } };
        assert.equal(results.returnedErrorGroups({ apiResults: [entry, { ...entry, index: 1 }] }).length, 2);
    }
    assert.equal(results.returnedErrorGroups({ apiResults: [error(0), error(0)] }).length, 2, "Repeated source indexes remain distinct observations.");
    const prefix = "Identical diagnostic prefix ".repeat(8), suffix = "Identical diagnostic tail ".repeat(9);
    const unequal = [error(0), error(1)].map((entry, index) => ({
        ...entry, errorDiagnostic: { ...entry.errorDiagnostic, message: prefix + `different middle ${index}` + suffix },
    }));
    const excerpts = results.returnedErrorGroups({ apiResults: unequal });
    assert.equal(excerpts.length, 2, "Compare complete diagnostics before presenting them.");
    assert.notEqual(excerpts[0].text, excerpts[1].text, "The distinguishing middle of a recorded reason stays visible.");
    assert.match(excerpts[0].text, /different middle 0/);
    assert.match(excerpts[1].text, /different middle 1/);
    const missing = results.returnedErrorGroups({ apiResults: [{ index: 0, statusCode: 403 }, { index: 1, statusCode: 403 }] });
    assert.equal(missing.length, 2);
    assert.match(missing[0].text, /403/);
    assert.match(missing[0].text, /not recorded/i);
    assert.deepEqual(results.returnedErrorGroups({ apiResults: [{ index: 0 }, { index: 1, statusCode: 200 }] }), []);
});

test("grouped screen reasons keep parent outcomes, partial coverage and conflicting facts separate", () => {
    const results = createRecordedResults({ screen: true });
    const call = { resultEvidence: { version: 1, contentStatus: "partial", resultCount: null },
        apiResults: [{ index: 0, statusCode: 403, errorCode: "EntryDenied",
            errorDiagnostic: { version: 1, source: "workiq-error-json", status: "recorded", statusCode: 409,
                code: "DiagnosticConflict", message: "The retained document could not be updated." } }] };
    const before = structuredClone(call);
    for (const outcome of ["failure", "success", "unknown", "partial"]) {
        const view = results.activitySummary("tool", [{ id: "own-call", outcome }], () => call, { contextual: true });
        assert.equal(view.summary[outcome], 1);
        assert.equal(view.summary.count, 1);
        assert.equal(view.reasons[0].rowId, "own-call");
        assert.match(view.reasons[0].reason, /status 409.*returned status 403.*returned code EntryDenied/);
        assert.equal(view.reasons[0].coverage.state, "partial");
        assert.equal(view.reasons[0].coverage.retained, 1);
        assert.equal(view.reasons[0].coverage.supplied, null);
        assert.match(view.reasons[0].coverage.text, /WIRE saved part of the response: 1 returned entry.*total is unknown/);
        assert.equal(view.reasons[0].items.filter(item => !item.interpretation).length, 1, "Retention coverage is not another source-recorded failure reason.");
        assert.ok(view.reasons[0].items.some(item => item.interpretation && item.label.startsWith("WIRE interpretation")));
        assert.ok(!view.reasons[0].reason.includes("of 1"), "One retained entry cannot become a known batch total.");
    }
    assert.deepEqual(call, before);
    const partial = { ...call, resultEvidence: { version: 1, contentStatus: "body-excluded", resultCount: 7 } };
    assert.equal(results.returnedCoverage(partial).text, "WIRE saved 1 of the 7 returned entries.");
    const missing = results.callReasonItems({}, "failure");
    assert.deepEqual(missing.filter(item => !item.interpretation), [{ label: null, text: "Failure reason was not saved" }]);
    assert.match(missing.find(item => item.interpretation).text, /error details are missing/);
    const parent = { failureEvidence: { version: 1, diagnostic: { version: 1, source: "completion-error",
        status: "recorded", message: "The batch was rejected.", details: [{ message: "The version is stale." }] } } };
    assert.deepEqual(results.callReasonItems(parent, "failure").map(item => item.text), ["The batch was rejected.", "The version is stale."]);
    for (const ordinal of [0, -1, 1.5, null, "6"]) assert.throws(() => results.callLabel(ordinal), /positive ordinal/);
});

test("retention coverage is typed separately and never strips equal words from a recorded diagnostic", () => {
    const results = createRecordedResults({ screen: true });
    const sourceText = "Only part of the returned results was retained; total unknown.";
    const call = { failureEvidence: { version: 1, diagnostic: { version: 1, source: "completion-error",
        status: "recorded", message: sourceText } } };
    const view = results.activitySummary("tool", [{ id: "original", outcome: "failure" }], () => call, { contextual: true });
    assert.deepEqual(view.reasons[0].items, [{ label: null, text: sourceText }]);
    assert.equal(view.reasons[0].coverage, null);
    const partial = { resultEvidence: { version: 1, contentStatus: "partial", resultCount: null }, apiResults: [{ index: 0, statusCode: 200 }] };
    const success = results.activitySummary("tool", [{ id: "completed", outcome: "success" }], () => partial, { contextual: true });
    assert.equal(success.summary.success, 1);
    assert.equal(success.summary.failure, 0);
    assert.equal(success.reasons[0].coverage.state, "partial");
    assert.equal(results.returnedCoverage({ resultEvidence: { version: 1, contentStatus: "body-excluded", resultCount: 1 }, apiResults: [{}] }), null);
});

test("successful body exclusion stays a retained policy fact, not a screen reason bullet", () => {
    const results = createRecordedResults({ screen: true });
    const call = { resultEvidence: { version: 1, contentStatus: "body-excluded" } };
    const row = { id: "completed", outcome: "success" };
    assert.deepEqual(results.activitySummary("tool", [row], () => call, { contextual: true }).reasons, []);
    assert.equal(results.activitySummary("tool", [row], () => call).reasons[0].reason,
        "Tool completed; response body excluded from retention", "Default projection remains unchanged.");
    assert.deepEqual(results.resultDetails(call.resultEvidence), [["Result content", "Response bodies are excluded from activity retention."]]);
    call.resultEvidence.diagnostic = { version: 1, status: "recorded", source: "result-error", message: "Response body excluded from retention" };
    assert.equal(results.activitySummary("tool", [row], () => call, { contextual: true }).reasons[0].reason,
        "Response body excluded from retention", "Actual diagnostic words are never stripped by string matching.");
});

test("report all/current/selected retain full-group results and disclose missing counts", () => {
    const source = fixture("report-mixed"), other = fixture("report-other");
    source.toolCalls.push({ ...structuredClone(source.toolCalls[0]), toolCallId: "failure", startEventId: "failure-start", toolSucceeded: false, apiResults: [] });
    const catalog = buildExportCatalog([source, other]);
    const scopes = createReportScope();
    for (const kind of ["all", "current", "selected"]) {
        const selection = scopes.resolve(catalog, kind, ["report-mixed"], ["report-mixed"]);
        assert.equal(selection.counts.workIqActions, kind === "all" ? 3 : 2);
        const full = selection.requests.find(r => r.scenarioId === "report-mixed").results.tool;
        assert.equal(full.success, 1);
        assert.equal(full.failure, 1);
    }
    delete catalog.requests[0].counts.workIqActions;
    const broken = scopes.resolve(catalog, "all", [], []);
    assert.equal(broken.available, false);
    assert.equal(broken.counts.workIqActions, null);
    assert.match(scopes.summary(broken), /unavailable.*not zero/);
});

test("Activity result gaps and non-tool layers never inherit a tool cause or a success-shaped fallback", () => {
    const results = createRecordedResults();
    const unexpected = () => { throw new Error("A nonfailure row must not request a tool cause."); };
    assert.equal(results.activitySummary("tool", undefined, unexpected), null);
    assert.equal(results.activitySummary("tool", [{ id: "invalid" }], unexpected), null);
    const empty = results.activitySummary("tool", [], unexpected);
    assert.equal(empty.outcome, null);
    assert.equal(empty.summary.count, 0);
    for (const outcome of ["success", "partial", "unknown", "transport", "other"]) {
        const value = results.activitySummary("tool", [{ id: outcome, outcome }], unexpected);
        assert.equal(value.outcome, outcome);
        assert.deepEqual(value.reasons, []);
        assert.equal(value.moreReasons, 0);
    }
    for (const layer of results.layers.filter(layer => layer !== "tool")) {
        const value = results.activitySummary(layer, [{ id: "result", outcome: "failure" }], unexpected);
        assert.deepEqual(value.reasons, [], layer);
        assert.equal(value.moreReasons, 0, layer);
        assert.equal(value.outcome, layer === "code-reference" ? "unknown" : "failure", layer);
    }
});

test("full-request context uses canonical identities and keeps batched API units separate", () => {
    const source = fixture("mixed");
    const call = source.toolCalls[0];
    source.toolCalls.push({ ...structuredClone(call), toolCallId: "failed", startEventId: "failed-start", toolSucceeded: false, apiResults: [] });
    call.apiResults.push({ index: 1, statusCode: 429 }, { index: 2 });
    const legacy = { ...structuredClone(source), scenarioId: "alias", isLegacy: true };
    const records = [legacy, source];
    const context = buildRequestActivity(records);
    const filtered = buildActivityAnalytics(records, { filters: { scope: "all", outcomes: ["failure"] } });
    assert.equal(filtered.totals.count, 1);
    assert.equal(context.tool.length, 2);
    assert.equal(context["reported-api"].length, 3);
    assert.equal(context.tool[0].scenarioId, "mixed");
    assert.ok(context.tool.every(row => row.scenarioIds.includes("alias")));
    assert.deepEqual(createRecordedResults().summarize(context["reported-api"]), { count: 3, success: 1, failure: 1, unknown: 1, partial: 0, other: 0, transport: 0 });
});

test("literal API paths preserve all retained characters and missing targets without normalization", () => {
    const results = createRecordedResults();
    const path = "/Users/{User-ID}/messages?$filter=subject%20eq%20'\u65e5\u672c\u8a9e'&Case=Keep+This";
    const call = Object.freeze({ requestedApiPath: "/wrong-shortcut", requestArgs: Object.freeze({ entityUrls: Object.freeze([path, { path: "/me/drive/root:/A B:/children?x=<tag>" }, null]) }) });
    assert.deepEqual(results.callPaths(call), [path, "/me/drive/root:/A B:/children?x=<tag>", null]);
    assert.deepEqual(results.callPaths({ requestArgs: { functionUrl: "/me/getSchedule(Time='A')" } }), ["/me/getSchedule(Time='A')"]);
    assert.deepEqual(results.callPaths({}), [null]);
    assert.equal(results.pathText({ label: "/not-a-retained-path" }), null);
    assert.equal(results.pathText("//Keep//Slashes?x=%2F#Fragment"), "//Keep//Slashes?x=%2F#Fragment");
});

test("returned paths follow canonical parent and filtered offset, never source index or first batch target", () => {
    const results = createRecordedResults();
    const record = fixture("returned-paths");
    const call = record.toolCalls[0];
    call.requestArgs.entityUrls = ["/me/messages", "/me/calendar/events"];
    call.apiResults = [null, { unrelated: true }, { index: 99, statusCode: 200, path: "/me/messages?Case=A" }, { index: 99, statusCode: 429, requestedApiPath: "/me/calendar/events?Case=B" }, { index: 0 }];
    const rows = buildRequestActivity([record])["reported-api"];
    assert.deepEqual(rows.map(row => results.returnedPath(call, row)), [
        { path: "/me/messages?Case=A", source: "returned" }, { path: "/me/calendar/events?Case=B", source: "returned" },
        { path: null, source: "unattributed" },
    ]);
    call.requestArgs.entityUrls = ["/me/messages?Exact=%2F"];
    assert.deepEqual(results.returnedPath(call, rows[2]), { path: "/me/messages?Exact=%2F", source: "call" });
    call.requestArgs = {};
    call.requestedApiPath = null;
    assert.deepEqual(results.returnedPath(call, rows[2]), { path: null, source: "missing" });
});

test("only a qualified single-target fallback shares its parent's displayed service", () => {
    const results = createRecordedResults(), record = fixture("inherited-service");
    const call = record.toolCalls[0];
    call.requestArgs = { entityUrls: ["/me/messages/invented-workshop"] };
    delete call.requestedApiPath;
    const inherits = (index = 0) => {
        const rows = buildRequestActivity([record]);
        return results.inheritsCallService(call, rows["reported-api"][index], rows.tool[0]);
    };
    assert.equal(inherits(), true);
    call.apiResults = [
        { index: 7, statusCode: 200, path: "/me/messages/invented-reply" },
        { index: 7, statusCode: 200, path: "/me/calendar/events" },
        { index: 7, statusCode: 200 },
    ];
    assert.equal(inherits(0), false, "Same service, independently returned path: keep its attribution");
    assert.equal(inherits(1), false, "A different returned service must not inherit the parent");
    assert.equal(inherits(2), true, "Repeated source indices do not determine the result identity");
    const rows = buildRequestActivity([record]), parent = rows.tool[0], row = rows["reported-api"][2];
    const source = structuredClone(call);
    assert.equal(results.inheritsCallService(call, row, { ...parent, id: "unrelated-parent" }), false);
    assert.equal(results.inheritsCallService(call, { ...row, id: "unretained-result" }, parent), false);
    assert.equal(results.inheritsCallService(call, row, undefined), false);
    assert.equal(results.inheritsCallService(call, { ...row, serviceAssociation: undefined }, parent), false);
    assert.equal(results.inheritsCallService(call, row, { ...parent, serviceAssociation: { ...parent.serviceAssociation, status: "partial" } }), false);
    for (const patch of [{ status: "partial" }, { services: ["Files"] }, { basis: "tool-purpose" },
        { services: ["Mail", "Files"] }, { gaps: [{ reason: "missing-target" }] }]) {
        assert.equal(results.inheritsCallService(call, { ...row, serviceAssociation: { ...row.serviceAssociation, ...patch } }, parent), false);
    }
    call.requestArgs.entityUrls.push("/me/messages/another-invented-message");
    assert.equal(inherits(2), false, "Even same-service batches cannot attribute a pathless result by position");
    call.requestArgs.entityUrls.push("/me/drive/root", "/unrecognized/target");
    assert.equal(inherits(2), false);
    call.requestArgs = { entityUrls: ["/unrecognized/target"] };
    assert.equal(inherits(2), false, "Unknown equality is not service evidence");
    call.requestArgs = {};
    assert.equal(inherits(2), false);
    call.tool = "workiq-get_schema";
    call.requestArgs = { path: "/me/messages" };
    assert.equal(inherits(2), false, "Schema references never supply a result's service");
    const serialized = Function(`return (${createRecordedResults.toString()})()`)();
    assert.equal(serialized.inheritsCallService(source, row, parent), true);
});
