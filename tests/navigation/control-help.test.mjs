import test from "node:test";
import assert from "node:assert/strict";
import { renderHtmlShell } from "../../lib/render.mjs";
import { createControlHelp } from "../../lib/control-help.mjs";
import { createServiceCategories, serviceCategories } from "../../lib/service-categories.mjs";
import { OUTCOMES } from "../../lib/analytics.mjs";
import { buildActivityAnalytics } from "../../lib/activity-analytics.mjs";
import { fixture } from "../support/helpers.mjs";

const help = createControlHelp(serviceCategories);

test("timing help distinguishes tool latency, final response and measured coverage", () => {
    const { speed, coverage } = help.glossary;
    assert.equal(Object.hasOwn(help.glossary, "action-trust"), false);
    assert.equal(Object.hasOwn(help.glossary, "permission"), false);
    assert.match(speed.detail, /Tool latency starts when the tool call starts and ends at its recorded completion/);
    assert.match(speed.detail, /Final-response timing starts at the recorded request and ends at the recorded final response/);
    assert.match(speed.detail, /Concurrent tool latencies are not added together/);
    assert.match(speed.detail, /lower middle.*even count/);
    assert.match(coverage.definition, /does not rate the rest of your history/);
});

test("category filter help explains available choices without inventing service evidence", () => {
    const tool = help.categoryGuide(["Discovery", "Search", "Mail", "Multiple workloads", "Unknown"]);
    assert.match(tool, /One group per call; Service involved also finds a service within a multi-service call/);
    assert.match(help.charts.activityCategory, /Calls spanning several services are grouped as More than one service/);
    assert.doesNotMatch(help.categoryGuide(["Mail"], "reported-api"), /One group per call/);
    assert.match(tool, /Discovery:.*not data execution/);
    assert.match(tool, /Search and retrieval: may span sources/);
    assert.match(tool, /Mail names recorded service targets, not hidden traffic/);
    assert.match(tool, /More than one service: one call, different services/);
    assert.match(tool, /Service not shown: the record does not identify a service; this is not a failure result/);
    assert.doesNotMatch(help.categoryGuide(["Mail", "Calendar"]), /Discovery|Search and retrieval|Service not shown/);
    assert.doesNotMatch(help.categoryGuide(["Discovery", "Mail"], "reported-api"), /Discovery/);
});

test("each report scope and chart mode in the shell has a help entry", () => {
    const shell = renderHtmlShell("test", "nonce", null, { renderer: "react", entry: "/test.js", styles: [] });
    const values = pattern => [...shell.matchAll(pattern)].map(([, value]) => value).sort();
    assert.deepEqual(values(/name="reportScope" value="([^"]+)"/g), Object.keys(help.reportScopes).sort());
    assert.deepEqual(values(/data-chart="([^"]+)"/g), Object.keys(help.charts).filter(key => key !== "activityCategory").sort());
});

test("dynamic service and result choices use shared semantics without classifying unknown values", () => {
    const analytics = buildActivityAnalytics([fixture()]);
    for (const value of analytics.filterOptions.workloads) {
        assert.equal(help.describeOption({ id: "serviceFilter", value }), serviceCategories.describe(value).description);
    }
    for (const value of OUTCOMES) {
        const text = help.describeOption({ id: "outcomeFilter", value });
        assert.ok(text.trim());
        assert.doesNotMatch(text, /not recognized/);
    }
    assert.match(help.describeOption({ id: "serviceFilter", value: "Future category" }), /not recognized/);
    assert.match(help.describeOption({ id: "layerFilter", value: "future-layer" }), /not recognized/);
    assert.equal(help.describeOption({ id: "unowned-control", value: "anything" }), "", "Unowned controls receive no generic filler");
});

test("all six evidence layers disclose the unit and its critical limit", () => {
    assert.deepEqual(Object.keys(help.layers).sort(), ["tool", "reported-api", "direct-request", "recorded-http", "http", "code-reference"].sort());
    assert.match(help.layers.tool, /tool attempts.*does not prove/);
    assert.match(help.layers["direct-request"], /request sites.*not measured.*proof/);
    assert.match(help.layers["recorded-http"], /subset.*not extra/);
    assert.match(help.layers["reported-api"], /not directly observed.*one call may return several.*some calls have none/);
    assert.match(help.layers.http, /explicitly instrumented.*not all.*hidden/);
    assert.match(help.layers["code-reference"], /references alone do not establish.*request ran/);
    assert.match(help.resultHelp("success", "reported-api"), /2xx.*does not establish/);
    assert.match(help.resultHelp("failure", "reported-api"), /error code/);
    assert.match(help.resultHelp("unknown", "tool"), /not success or failure/);
    assert.match(help.resultHelp("unknown", "code-reference"), /do not have execution results/);
});

test("report and action guidance preserves source, privacy and selection boundaries", () => {
    assert.match(help.reportScopes.current, /Full interactions.*across all pages/);
    assert.match(help.reportScopes.selected, /other pages.*outside Analyze filters.*included/);
    assert.match(help.reportScopes.all, /Analyze dates, filters and search do not limit/);
    assert.equal(Object.hasOwn(help.actions, "exportBtn"), false, "The visible Prepare report action does not need a tutorial tooltip.");
    assert.doesNotMatch(help.facts["Snapshot revision"], /invalidates.*prepared report/);
    assert.match(help.reviewStates.ready_to_export, /not privacy-approved/);
    assert.match(help.actions.removeRequest, /selection only.*remain/);
    assert.match(help.actions.download, /not your current choices/);
    assert.match(help.notices.clipboard, /other apps.*masking is not applied/);
    assert.match(help.notices.followup, /inferred association.*not proof/);
    assert.match(help.facts.Provenance, /not.*proof.*human/);
    assert.match(help.facts["Visible statuses"], /subset/);
});

test("help serializes without module closures and keeps inputs and glossary unchanged", () => {
    const restored = Function(`return (${createControlHelp.toString()})((${createServiceCategories.toString()})());`)();
    assert.deepEqual(restored.glossary, help.glossary);
    assert.equal(restored.categoryGuide(["Discovery", "Mail"]), help.categoryGuide(["Discovery", "Mail"]));
    const option = Object.freeze({ id: "layerFilter", value: "tool", label: "Work IQ tool calls" });
    assert.equal(restored.describeOption(option), help.layers.tool);
    assert.equal(restored.describeOption({ id: "serviceFilter", value: "Search" }), serviceCategories.describe("Search").description);
    assert.equal(Object.isFrozen(help), true);
    assert.equal(Object.isFrozen(help.options.layerFilter), true);
    assert.throws(() => { help.layers.tool = "Different definition"; }, TypeError);
});
