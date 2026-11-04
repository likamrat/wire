import test from "node:test";
import assert from "node:assert/strict";
import { promptAuthorship, promptAvailabilityFields } from "../lib/prompt-authorship.mjs";
import { serviceCategories, createServiceCategories } from "../lib/service-categories.mjs";
import { classifyWorkload } from "../lib/graph-history.mjs";
import { buildSanitizedBundle } from "../lib/export.mjs";
import { renderHtmlReport } from "../lib/product-report.mjs";
import { fixture } from "./helpers.mjs";
import { createPercentageCharts } from "../lib/percentage-charts.mjs";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";

const automatic = { text: "", status: "full", authorship: { actor: "agent", basis: "autopilot" },
    capture: { version: 1, kind: "automatic-continuation", original: "empty", hostContext: "not-collected", reason: null } };

test("automatic continuation qualifies the verified author without creating an actor or changing retained notices", () => {
    const before = structuredClone(automatic);
    assert.deepEqual(promptAuthorship.display(automatic), {
        label: "Agent prompt (automatic continuation)", notice: "Work continued without a new message.", automatic: true,
    });
    assert.deepEqual(promptAvailabilityFields(automatic), { activityState: "automatic", availabilityNote: "No new message was sent." });
    assert.deepEqual(promptAuthorship.actors, ["user", "agent", "unknown"]);
    assert.equal(promptAuthorship.read(automatic).actor, "agent");
    assert.equal(promptAuthorship.selectionLabel(["agent"]), "Agent prompts");
    assert.deepEqual(automatic, before);
    for (const basis of ["conflicting-source", "missing-source", "invalid-source"]) {
        const unknown = { ...automatic, authorship: { actor: "unknown", basis } };
        assert.equal(promptAuthorship.display(unknown).label, "Author unverified (automatic continuation)");
        assert.equal(promptAuthorship.read(unknown).actor, "unknown");
    }
    const projected = { text: null, status: "unavailable", activityState: "automatic",
        availabilityNote: "No new message was sent.", authorship: automatic.authorship };
    assert.equal(promptAuthorship.display(projected, { ownerVoice: false }).label, "Agent prompt (automatic continuation)");
    const recorded = { ...automatic, text: "An invented recorded continuation instruction.",
        capture: { ...automatic.capture, original: "recorded" } };
    assert.equal(promptAuthorship.display(recorded).label, "Agent prompt (automatic continuation)");
    assert.equal(promptAuthorship.display(recorded).notice, null, "Retained text must not be described as absent");
});

function row(tool, path) {
    const value = { tool, workload: "Unknown", ...(path ? { endpoint: { path }, targets: [{ path }] } : {}) };
    value.serviceAssociation = serviceCategories.associate(value, "tool", classifyWorkload);
    return value;
}
test("service presentation keeps hosted routing, missing targets, unknown paths, preparation and partial targets distinct", () => {
    const ask = row("workiq-ask"), missing = row("workiq-fetch"), unknown = row("workiq-fetch", "/invented-unrecognized-service");
    const discovery = row("workiq-get_schema");
    const known = row("workiq-fetch", "/me/messages");
    const original = JSON.stringify([ask, missing, unknown, discovery, known]);
    const hosted = serviceCategories.availabilitySummary([ask], "tool");
    assert.equal(hosted.label, "Services not recorded");
    assert.equal(hosted.onlyHosted, true);
    assert.match(hosted.description, /Copilot may have used services/);
    assert.doesNotMatch(hosted.description, /not relevant|none were used/i);
    assert.equal(serviceCategories.availabilitySummary([missing], "tool").label, "Service target not recorded");
    assert.equal(serviceCategories.availabilitySummary([unknown], "tool").label, "Service not identified");
    assert.equal(serviceCategories.availabilitySummary([discovery], "tool"), null);
    const mixed = serviceCategories.availabilitySummary([known, ask, unknown], "tool");
    assert.equal(mixed.label, "Some service details unavailable");
    assert.equal(mixed.hasKnown, true);
    assert.equal(mixed.onlyHosted, false);
    assert.match(mixed.description, /Copilot may have used services/);
    assert.match(mixed.description, /path was recorded/);
    assert.equal(serviceCategories.display("Unknown").label, "Unidentified service");
    assert.equal(serviceCategories.describe("Unknown").label, "Service not shown", "Stored and historical vocabulary remains stable");
    assert.equal(JSON.stringify([ask, missing, unknown, discovery, known]), original);
});

test("screen attribution wording names recorded limits without implying service health or changing historical facts", () => {
    const ask = row("workiq-ask"), search = row("workiq-retrieve"), files = row("workiq-fetch", "/me/drive/root");
    const missing = row("workiq-fetch"), unknown = row("workiq-fetch", "/invented-unrecognized-service");
    const unsupported = row("workiq-fetch", "[endpoint unavailable]");
    const returned = { workload: "Unknown", endpoint: { id: "operation:unattributed-batch-result" } };
    returned.serviceAssociation = serviceCategories.associate(returned, "reported-api", classifyWorkload);
    const all = [ask, search, files, missing, unknown, unsupported, returned], before = structuredClone(all);
    const shown = (rows, layer = "tool") => serviceCategories.availabilitySummary(rows, layer, { screen: true });
    assert.equal(shown([search, search, ask]).label, "Underlying services not recorded");
    assert.equal(shown([files, search, ask]).label, "Underlying services not recorded");
    assert.equal(shown([search, ask]).notice, null);
    assert.equal(shown([files, search, ask]).notice, null);
    assert.equal(shown([missing]).label, "Service target not recorded");
    assert.equal(shown([files, unknown]).label, "Recorded path not recognized");
    assert.equal(shown([unsupported]).label, "Recorded target format unsupported");
    assert.equal(shown([returned], "reported-api").label, "Returned target not identified");
    assert.equal(shown([files]), null);
    assert.equal(shown([search]), null, "A purpose-only retrieval is not given a new gap.");
    assert.equal(shown([row("workiq-get_schema")]), null);
    assert.equal(shown(undefined).label, "Service evidence could not be read");
    assert.equal(shown([ask]).onlyHosted, true);
    assert.equal(shown([search, ask]).hasKnown, true, "Historical category-known state is not reclassified to change display.");
    assert.equal(shown([search, ask]).hasIdentifiedService, false, "Search by purpose is not an identified underlying service.");
    assert.equal(shown([files, ask]).hasIdentifiedService, true);
    const serialized = Function(`return (${createServiceCategories.toString()})()`)();
    assert.deepEqual(serialized.availabilitySummary([files, search, ask], "tool", { screen: true }), shown([files, search, ask]));
    const mixed = shown([files, ask, missing, unknown]);
    assert.match(mixed.label, /Underlying services not recorded/);
    assert.doesNotMatch(mixed.notice, /underlying services/i);
    assert.match(mixed.label, /Service target not recorded/);
    assert.match(mixed.label, /Recorded path not recognized/);
    assert.match(mixed.description, /if any/);
    assert.match(mixed.description, /WIRE cannot classify/);
    for (const rows of [[search, ask], [files, ask], [missing], [unknown], [unsupported], [returned]]) {
        assert.doesNotMatch(shown(rows, rows[0] === returned ? "reported-api" : "tool").label,
            /unavailable|failed|healthy|sign.in/i);
    }
    assert.equal(serviceCategories.availabilitySummary([files, ask]).label, "Some service details unavailable");
    assert.equal(serviceCategories.displayEvidence(ask.serviceAssociation.gaps[0]).label, "Services not recorded");
    assert.equal(serviceCategories.describe("Unknown").label, "Service not shown");
    assert.deepEqual(all, before, "No service association, evidence count, category or source fact changes.");
});

test("attribution reading explains basis, counting significance and action without inventing upstream provenance", () => {
    const ask = row("workiq-ask"), search = row("workiq-retrieve");
    const missing = row("workiq-fetch"), unknown = row("workiq-fetch", "/invented-service/items");
    const unsupported = row("workiq-fetch", "[endpoint unavailable]"), files = row("workiq-fetch", "/me/drive/root");
    const records = [ask, search, missing, unknown, unsupported, files], before = structuredClone(records);
    const reader = value => serviceCategories.attributionReading(value);
    assert.equal(reader(ask).kind, "operation");
    assert.match(reader(ask).text, /counts this call as Asked Copilot.*not confirmed use of a named app/);
    assert.match(reader(ask).text, /not an app-by-app execution trace.*not a service error.*does not call for a retry, sign-in or history repair/);
    assert.match(serviceCategories.attributionReading(ask, "tool", { hasInputReferences: true }).text,
        /Input file references provide context, not proof/);
    assert.match(reader(search).text, /counts the search request, not the apps searched/);
    assert.match(reader(search).text, /not a failed search/);
    assert.match(reader(missing).text, /source omission or a capture problem/);
    assert.match(reader(missing).text, /still counts.*service counts/);
    assert.match(reader(unknown).text, /path is present.*cannot classify.*Inspect the recorded request/);
    assert.match(reader(unsupported).text, /metadata is present.*cannot interpret.*service or sign-in failure/);
    assert.equal(reader(files), null);
    assert.equal(reader(row("workiq-get_schema")), null);
    assert.equal(reader(undefined).kind, "read-error");
    assert.match(reader(undefined).text, /could not read.*not a recorded service failure/);
    const prose = { ...ask, prompt: "Mail failed", response: "Teams used", outcome: "failure" };
    assert.deepEqual(reader(prose), reader(ask), "The interpretation comes from retained attribution, not source prose or success.");
    for (const value of records) assert.doesNotMatch(reader(value)?.text ?? "", /Work IQ never|enable.*replies|healthy|source did not supply/i);
    assert.deepEqual(records, before);
    const serialized = Function(`return (${createServiceCategories.toString()})()`)();
    assert.deepEqual(serialized.attributionReading(ask), reader(ask));
});

test("screen service descriptions preserve chart gap counts and canonical service memberships", () => {
    const record = fixture("attribution-chart");
    record.toolCalls[0].requestArgs = { entityUrls: ["/me/drive/root", "/invented-service/items"] };
    record.toolCalls[0].requestedApiPath = null;
    const analytics = buildActivityAnalytics([record]), before = structuredClone(analytics);
    const historical = createPercentageCharts({ categories: serviceCategories, dimensional: createDimensionalCharts(),
        results: createRecordedResults() }).model(analytics).services;
    const screen = createPercentageCharts({ categories: { ...serviceCategories,
        displayEvidence: gap => serviceCategories.displayEvidence(gap, { screen: true }),
    }, dimensional: createDimensionalCharts(), results: createRecordedResults() }).model(analytics).services;
    assert.deepEqual(screen.recordedRows, historical.recordedRows);
    assert.equal(screen.missingDetailCount, historical.missingDetailCount);
    assert.deepEqual(screen.unresolved.drilldownIds, historical.unresolved.drilldownIds);
    assert.equal(screen.unresolved.gaps[0].label, "Recorded path not recognized");
    assert.equal(screen.unresolved.gaps[0].count, historical.unresolved.gaps[0].count);
    assert.equal(screen.unresolved.gaps[0].id, historical.unresolved.gaps[0].id);
    assert.deepEqual(analytics, before);
});

test("native target qualification stays canonical while shared card and chart presenters explain it", () => {
    const gap = { reason: "native-target-unqualified", label: "Service not qualified",
        description: "Native source target qualification is unavailable." };
    const record = fixture("invented-native-gap-call");
    record.toolCalls[0].requestArgs = {};
    record.toolCalls[0].requestedApiPath = null;
    const analytics = buildActivityAnalytics([record]);
    analytics.rows[0].serviceAssociation.gaps = [gap];
    const before = structuredClone(analytics), shown = serviceCategories.displayEvidence(gap);
    assert.equal(shown.label, "Service not identified");
    assert.equal(shown.description, "This record does not establish which service was used.");
    assert.equal(serviceCategories.availabilitySummary(analytics.rows, "tool").label, shown.label);
    const charts = createPercentageCharts({ categories: serviceCategories, dimensional: createDimensionalCharts(),
        results: createRecordedResults() });
    const presented = charts.model(analytics).services;
    assert.equal(presented.unresolved.gaps[0].label, shown.label);
    assert.equal(presented.unresolved.gaps[0].description, shown.description);
    assert.equal(presented.unresolved.gaps[0].id, "native-target-unqualified");
    assert.deepEqual(analytics, before);
});

test("v3 report copies share author/service wording while v2 rendering and stored availability remain unchanged", async () => {
    const record = fixture("invented-vocabulary-report");
    record.userPrompt = { ...automatic, sourceEventId: "invented-auto-prompt", sourceTimestamp: "2026-10-01T12:00:00.000Z" };
    record.followUpPrompts = [];
    record.toolCalls[0].tool = "workiq-ask";
    record.toolCalls[0].requestArgs = { question: "An invented planning request." };
    record.toolCalls[0].requestedApiPath = null;
    const before = structuredClone(record);
    const bundle = await buildSanitizedBundle([record], "a".repeat(64), { promptMode: "original", formats: ["html", "markdown", "json"] });
    const prompt = bundle.snapshot.records[0].prompts[0];
    assert.equal(prompt.activityState, "automatic");
    assert.equal(prompt.availabilityNote, "No new message was sent.");
    assert.deepEqual(prompt.authorship, automatic.authorship);
    assert.equal(bundle.snapshot.categoryDefinition.version, 3);
    assert.equal(bundle.snapshot.serviceCategories.find(entry => entry.id === "Unknown").label, "Unidentified service");
    for (const output of [bundle.previewHtml, bundle.files["product-report.md"]]) {
        assert.match(output, /Agent prompt \(automatic continuation\)/);
        assert.match(output, /Work continued without a new message/);
        assert.doesNotMatch(output, /Service not shown/);
    }
    const older = { ...bundle.snapshot, presentation: { schemaVersion: 2 } };
    const legacy = renderHtmlReport(older.records, { snapshot: older });
    assert.match(legacy, /Automatic continuation/);
    assert.doesNotMatch(legacy, /Agent prompt \(automatic continuation\)/);
    assert.deepEqual(record, before);
});
