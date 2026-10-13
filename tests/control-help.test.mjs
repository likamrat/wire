import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createControlHelp } from "../lib/control-help.mjs";
import { createAssessmentWording } from "../web/assessment-presentation.mjs";
import { createServiceCategories, serviceCategories } from "../lib/service-categories.mjs";
import { OUTCOMES } from "../lib/analytics.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { fixture } from "./helpers.mjs";

const help = createControlHelp(serviceCategories);

test("measure help leads with the human meaning and keeps calculation limits in the glossary", () => {
    const { accuracy, speed, trust, coverage, unassessed } = help.glossary;
    assert.match(accuracy.definition, /answer meet the request.*saved evidence/);
    assert.doesNotMatch(accuracy.definition, /divided|denominator|rubric/);
    assert.match(accuracy.detail, /passed plus failed/);
    assert.match(accuracy.detail, /without a result.*left out.*included in coverage/);
    assert.match(trust.definition, /Answer support and tool use vs. request.*separate/);
    assert.match(help.glossary["action-trust"].definition, /does not establish permission/);
    assert.match(speed.detail, /call starts.*recorded completion/);
    assert.match(speed.detail, /recorded request.*recorded final response/);
    assert.match(speed.detail, /lower middle.*even count/);
    assert.match(speed.detail, /Concurrent call times are not added/);
    assert.match(coverage.definition, /does not rate the rest of your history/);
    assert.match(unassessed.detail, /error, not a failed answer/);
    assert.match(unassessed.detail, /does not mean one is queued/);
    const restored = Function(`return (${createControlHelp.toString()})((${createServiceCategories.toString()})(), (${createAssessmentWording.toString()})());`)();
    assert.deepEqual(restored.glossary, help.glossary, "The normal shell uses the same short and detailed copy.");
});

test("category filter help explains available choices without inventing service evidence", () => {
    const tool = help.categoryGuide(["Discovery", "Search", "Mail", "Multiple workloads", "Unknown"]);
    assert.match(tool, /Discovery:.*not data execution/);
    assert.match(tool, /Search and retrieval: may span sources/);
    assert.match(tool, /Mail names recorded service targets, not hidden traffic/);
    assert.match(tool, /More than one service: one call, different services/);
    assert.match(tool, /Service not shown: insufficient service evidence, not failure/);
    assert.doesNotMatch(help.categoryGuide(["Mail", "Calendar"]), /Discovery|Search and retrieval|Service not shown/);
    assert.doesNotMatch(help.categoryGuide(["Discovery", "Mail"], "reported-api"), /Discovery/);
    const restored = Function(`return (${createControlHelp.toString()})((${createServiceCategories.toString()})(), (${createAssessmentWording.toString()})());`)();
    assert.equal(restored.categoryGuide(["Discovery", "Mail"]), help.categoryGuide(["Discovery", "Mail"]));
});

test("every authored filter has shared definitions for contextual help outside its menu", async () => {
    const source = await readFile(new URL("../lib/render.mjs", import.meta.url), "utf8");
    const controls = [...source.matchAll(/<select\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)];
    const known = [...Object.keys(help.options), "serviceFilter", "projectFilter", "outcomeFilter"].sort();
    assert.deepEqual(controls.map(([, id]) => id).sort(), known, "New select controls require a help coverage decision");
    for (const [, id, html] of controls) {
        const values = [...html.matchAll(/<option value="([^"]+)"/g)].map(([, value]) => value);
        if (help.options[id]) assert.deepEqual([...values].sort(), Object.keys(help.options[id]).sort(), `${id}: new enum choices need descriptions`);
        for (const value of values) {
            const text = help.describeOption({ id, value });
            assert.ok(text.trim(), `${id}/${value}: retained choice definition`);
            assert.doesNotMatch(text, /not recognized/);
        }
    }
    assert.deepEqual(Object.keys(help.reportScopes).sort(), [...source.matchAll(/name="reportScope" value="([^"]+)"/g)].map(([, value]) => value).sort());
    assert.deepEqual(Object.keys(help.charts).sort(), [...source.matchAll(/data-chart="([^"]+)"/g)].map(([, value]) => value).sort());
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
    assert.match(help.layers["reported-api"], /one call may return several.*some calls have none/);
    assert.match(help.layers.http, /explicitly instrumented.*not all.*hidden/);
    assert.match(help.layers["code-reference"], /do not establish.*ran/);
    assert.match(help.resultHelp("success", "reported-api"), /2xx.*does not establish/);
    assert.match(help.resultHelp("failure", "reported-api"), /error code/);
    assert.match(help.resultHelp("unknown", "tool"), /not success or failure/);
    assert.match(help.resultHelp("unknown", "code-reference"), /do not have execution results/);
});

test("report and action guidance preserves source, privacy and selection boundaries", () => {
    assert.match(help.reportScopes.current, /every page.*complete eligible evidence/);
    assert.match(help.reportScopes.selected, /outside this view.*complete eligible evidence/);
    assert.match(help.reportScopes.all, /regardless.*no new scan/);
    assert.match(help.reviewStates.ready_to_export, /not privacy-approved/);
    assert.match(help.actions.removeRequest, /selection only.*remain/);
    assert.match(help.actions.download, /not your current choices/);
    assert.match(help.notices.clipboard, /other apps.*masking is not applied/);
    assert.match(help.notices.followup, /inferred association.*not proof/);
    assert.match(help.facts.Provenance, /not.*proof.*human/);
    assert.match(help.facts["Visible statuses"], /subset/);
});

test("help serializes without module closures and keeps inputs and glossary unchanged", () => {
    const restored = Function(`return (${createControlHelp.toString()})((${createServiceCategories.toString()})(), (${createAssessmentWording.toString()})());`)();
    const option = Object.freeze({ id: "layerFilter", value: "tool", label: "Work IQ tool calls" });
    assert.equal(restored.describeOption(option), help.layers.tool);
    assert.equal(restored.describeOption({ id: "serviceFilter", value: "Search" }), serviceCategories.describe("Search").description);
    assert.equal(Object.isFrozen(help), true);
    assert.equal(Object.isFrozen(help.options.layerFilter), true);
    assert.throws(() => { help.layers.tool = "Different definition"; }, TypeError);
});
