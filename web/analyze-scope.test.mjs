import test from "node:test";
import assert from "node:assert/strict";
import { createAnalyzeScope } from "./analyze-scope.mjs";
import { createRecordedResults } from "./recorded-results.mjs";
import { createPromptAuthorship } from "../lib/prompt-authorship.mjs";
import { createFilterState } from "./client.mjs";

const filters = createFilterState(createRecordedResults(), createPromptAuthorship());
const scope = createAnalyzeScope(createRecordedResults(), createPromptAuthorship(), value => value, filters.sourceLabel);

test("native group refinement remains in accepted captions and the active filter count", () => {
    const value = scope.describe({ applied: { layer: "tool", filters: { scope: "history", sources: ["microsoft-365-cowork"] } },
        acceptedRoute: { nativeGroupLabel: "Unknown" }, snapshot: { scenarios: [], sessions: [] }, analytics: {}, period: "All dates" });
    assert.equal(value.activeCount, 2);
    assert.equal(value.restrictionText, "Source: Cowork; Microsoft group: Unknown");
});

test("source captions share one accepted selection across ordinary and paired scopes", () => {
    for (const { id, label } of filters.sources) {
        const options = { layer: "tool", filters: { scope: "history", sources: [id] } };
        const ordinary = scope.describe({ applied: options, acceptedRoute: {}, snapshot: { scenarios: [], sessions: [] },
            analytics: {}, period: "All dates", requested: { source: "another-source" } });
        assert.equal(ordinary.text, `All dates; Saved collection; Source: ${label}`);
        assert.deepEqual(ordinary.restrictions, [`Source: ${label}`]);
        assert.equal(ordinary.activeCount, 1);
        const paired = scope.describePair({ key: "pair", revision: 1,
            comparison: { kind: "retained-period-comparison", schemaVersion: 1, revision: 1,
                options, selection: { withinServices: [] } }, scope: { hasSearch: false, projects: [], sessions: [], endpoints: [] } });
        assert.equal(paired.text, ordinary.restrictionText);
        assert.equal(paired.activeCount, 1);
    }
    assert.throws(() => scope.describe({ applied: { layer: "tool", filters: { scope: "history", sources: ["unknown"] } },
        acceptedRoute: {}, snapshot: {}, analytics: {}, period: "All dates" }), /source.*unavailable/i);
});

test("paired captions describe only accepted common restrictions, without dates, defaults or period counts", () => {
    const pair = {
        key: "period:7", revision: 3,
        comparison: { kind: "retained-period-comparison", schemaVersion: 1, revision: 3,
            options: { layer: "tool", filters: { scope: "history", outcomes: ["failure"] } }, selection: { withinServices: [] } },
        scope: { hasSearch: false, projects: [], sessions: [], endpoints: [] },
    };
    Object.defineProperty(pair.comparison, "periods", { get() { throw Error("Do not pool period facts for a common caption."); } });
    assert.deepEqual(scope.describePair(pair), { text: "Outcome: Tool failed", parts: ["Outcome: Tool failed"],
        activeCount: 1, restrictions: ["Outcome: Tool failed"], restrictionText: "Outcome: Tool failed" });
    delete pair.comparison.options.filters.outcomes;
    assert.deepEqual(scope.describePair(pair), { text: "", parts: [], activeCount: 0, restrictions: [], restrictionText: "" });
    assert.equal(scope.describePair(null), null);
});

test("paired restrictions reuse canonical labels and captured names without inventing shared service counts", () => {
    const pair = {
        key: "period:8", revision: 4,
        comparison: { kind: "retained-period-comparison", schemaVersion: 1, revision: 4,
            options: { layer: "http", filters: { scope: "all", tools: ["fetch"], services: ["Files"], includeMissingService: true,
                workloads: ["Files"], outcomes: ["failure"], promptAuthors: ["user", "agent"],
                projectIds: ["project", null, "missing"], sourceSessionIds: ["source", "missing"], endpoints: ["path", "missing"] } },
            selection: { withinServices: ["Files", "Mail"] } },
        scope: { hasSearch: true, projects: [{ id: "project", name: "Accepted project" }, { id: "missing", name: null }],
            sessions: [{ id: "source", name: "Accepted recorder" }, { id: "missing", name: null }],
            endpoints: [{ id: "path", name: "Accepted path" }, { id: "missing", name: null }] },
    };
    Object.defineProperty(pair.comparison, "periods", { get() { throw Error("A and B counts have no shared denominator."); } });
    Object.defineProperty(pair, "requested", { get() { throw Error("Do not read newer controls."); } });
    const value = scope.describePair(pair);
    assert.equal(value.text, "Both collections; Tool: fetch; Service: Files; Missing-service context allowed"
        + "; Category: Files; Outcome: HTTP 4xx/5xx; Author: My and agent prompts"
        + "; Copilot project: Accepted project, Project not recorded, Project unavailable"
        + "; Recorder source: Accepted recorder, Source unavailable; API path: Accepted path, Selected path unavailable"
        + "; Files within current scope; Mail within current scope; Search applied");
    assert.equal(value.activeCount, 14);
    assert.equal(value.parts.join("; "), value.text);
    assert.equal(value.restrictions.join("; "), value.restrictionText);
    assert.equal(value.restrictionText, value.text);
    assert.doesNotMatch(value.text, /known matches|context-only|All dates|Activity:|%/);
    pair.comparison.options.filters.includeMissingService = false;
    const strict = scope.describePair(pair);
    assert.match(strict.text, /Service: Files only;/);
    assert.doesNotMatch(strict.text, /missing-service/);
    assert.equal(strict.activeCount, 13);
});

test("malformed or mismatched paired authority cannot become an unrestricted caption", () => {
    const pair = {
        key: "period:9", revision: 5,
        comparison: { kind: "retained-period-comparison", schemaVersion: 1, revision: 5,
            options: { layer: "tool", filters: { scope: "history" } }, selection: { withinServices: [] } },
        scope: { hasSearch: false, projects: [], sessions: [], endpoints: [] },
    };
    for (const change of [
        value => { delete value.revision; delete value.comparison.revision; },
        value => { value.revision++; },
        value => { value.scope.hasSearch = "PRIVATE_QUERY"; },
        value => { value.scope.projects = [{ id: "project", name: { unbound: true } }]; },
        value => { value.comparison.options.filters.from = "2026-01-01"; },
        value => { value.scope = null; },
    ]) {
        const changed = structuredClone(pair); change(changed);
        assert.throws(() => scope.describePair(changed), /Accepted comparison scope/);
    }
});

test("paired outcome wording keeps returned results and unobserved code references distinct", () => {
    for (const [layer, label] of [["reported-api", "Outcome: Error result"],
        ["code-reference", "Previous outcome: Tool failed (execution not observed)"]]) {
        const pair = { key: "period:10", revision: 6,
            comparison: { kind: "retained-period-comparison", schemaVersion: 1, revision: 6,
                options: { layer, filters: { scope: "history", outcomes: ["failure"] } }, selection: { withinServices: [] } },
            scope: { hasSearch: false, projects: [], sessions: [], endpoints: [] } };
        assert.deepEqual(scope.describePair(pair), { text: label, parts: [label], restrictions: [label],
            restrictionText: label, activeCount: 2 });
    }
});

test("dashboard captions describe accepted filters, never newer requested intent", () => {
    const value = scope.describe({
        applied: { layer: "tool", filters: { scope: "history", tools: ["workiq-fetch"] } },
        acceptedRoute: {}, snapshot: { scenarios: [], sessions: [] }, analytics: {},
        period: "All dates",
        requested: { layer: "tool", filters: { scope: "all", tools: ["workiq-ask"], services: ["Files"] } },
    });

    assert.equal(value.text, "All dates; Saved collection; Tool: workiq-fetch");
    assert.deepEqual(value.parts, ["All dates", "Saved collection", "Tool: workiq-fetch"]);
    assert.equal(value.restrictionText, "Tool: workiq-fetch");
    assert.equal(value.activeCount, 1);
    assert.deepEqual(value.restrictions, ["Tool: workiq-fetch"]);
    assert.doesNotMatch(value.text, /workiq-ask|Files|Both collections/);
});

test("accepted captions retain non-date restrictions and known versus context-only service membership", () => {
    const value = scope.describe({
        applied: { layer: "tool", filters: { scope: "all", from: "2026-01-12", to: "2026-01-26",
            tools: ["workiq-fetch"], services: ["Files"], includeMissingService: true, workloads: ["Multiple workloads"],
            outcomes: ["failure"], promptAuthors: ["user", "agent"], projectIds: ["project-a"],
            sourceSessionIds: ["chat-a"], endpoints: ["operation:workiq-fetch"] } },
        acceptedRoute: {}, period: "Jan 12 - Jan 26", hasSearch: true,
        snapshot: { scenarios: [{ projectId: "project-a", project: "Invented project" }],
            sessions: [{ sessionId: "chat-a", name: "Invented chat" }] },
        analytics: {
            filterOptions: { endpoints: [{ id: "operation:workiq-fetch", label: "workiq-fetch" }] },
            serviceInvolvement: { selection: { knownMatchIds: ["a", "b", "c"], contextOnlyIds: ["d"], includeMissingService: true } },
        },
    });
    assert.equal(value.text, "Jan 12 - Jan 26; Both collections; Tool: workiq-fetch; Service: Files"
        + "; Includes missing-service context: 3 known matches; 1 context-only; Category: Multiple workloads"
        + "; Outcome: Tool failed; Author: My and agent prompts; Copilot project: Invented project"
        + "; Copilot chat: Invented chat; API path: workiq-fetch; Search applied");
    assert.equal(value.activeCount, 12);
    assert.deepEqual(value.restrictions, [
        "Jan 12 - Jan 26", "Both collections", "Tool: workiq-fetch", "Service: Files",
        "Includes missing-service context: 3 known matches; 1 context-only", "Category: Multiple workloads",
        "Outcome: Tool failed", "Author: My and agent prompts", "Copilot project: Invented project",
        "Copilot chat: Invented chat", "API path: workiq-fetch", "Search applied",
    ]);
    assert.deepEqual(value.parts, value.restrictions);
    assert.equal(value.restrictionText, value.text);
});

test("layer, strict service scope and accepted chart refinements stay explicit when source names are unavailable", () => {
    const value = scope.describe({
        applied: { layer: "http", filters: { scope: "legacy", services: ["Files"], includeMissingService: false,
            sourceSessionIds: ["unavailable-recorder"] } },
        acceptedRoute: { withinServices: "Files" }, period: "All dates",
        snapshot: { scenarios: [], sessions: [] },
        analytics: { serviceInvolvement: { selection: { knownMatchIds: ["a", "b"], contextOnlyIds: [], includeMissingService: false } } },
    });
    assert.equal(value.text, "All dates; Earlier snapshot; Activity: owned HTTP records"
        + "; Service: Files only (2 known matches); Recorder source: Source unavailable; Files within current scope");
    assert.equal(value.activeCount, 5);
    assert.deepEqual(value.restrictions, ["Earlier snapshot", "Service: Files only (2 known matches)",
        "Recorder source: Source unavailable", "Files within current scope"]);
});

test("retained outcome restrictions on code references never imply observed execution", () => {
    const value = scope.describe({
        applied: { layer: "code-reference", filters: { scope: "history", outcomes: ["failure"] } },
        acceptedRoute: {}, period: "All dates", analytics: {}, snapshot: { scenarios: [], sessions: [] },
    });
    assert.equal(value.text, "All dates; Saved collection; Activity: Graph code references"
        + "; Previous outcome: Tool failed (execution not observed)");
    assert.equal(value.activeCount, 2);
    assert.deepEqual(value.restrictions, ["Previous outcome: Tool failed (execution not observed)"]);
});

test("default scope adds no recap when the evidence unit is already labeled", () => {
    for (const layer of ["tool", "reported-api", "code-reference"]) {
        const value = scope.describe({ applied: { layer, filters: { scope: "history" } },
            acceptedRoute: {}, period: "All dates", analytics: {}, snapshot: { scenarios: [], sessions: [] } });
        assert.deepEqual(value.restrictions, []);
        assert.match(value.text, /All dates; Saved collection/);
        assert.deepEqual(value.parts.slice(0, 2), ["All dates", "Saved collection"]);
        assert.equal(value.parts.join("; "), value.text);
        assert.equal(value.restrictionText, "");
    }
});

test("malformed accepted scope cannot silently look like an unrestricted view", () => {
    const input = { applied: { layer: "tool", filters: { scope: "history" } },
        acceptedRoute: {}, period: "All dates", analytics: {}, snapshot: { scenarios: [], sessions: [] } };
    assert.throws(() => scope.describe({ ...input, applied: { ...input.applied, filters: { scope: "invalid" } } }), /collection/i);
    assert.throws(() => scope.describe({ ...input, applied: { ...input.applied, filters: { scope: "history", services: ["Files"] } } }), /service selection/i);
    assert.throws(() => scope.describe({ ...input, applied: { ...input.applied, filters: { scope: "history", outcomes: ["invalid"] } } }), /outcome/i);
});

test("complete structured parts preserve source punctuation and default facts without parsing text", () => {
    const name = "Invented A \u00b7 B; C: source name";
    const value = scope.describe({
        applied: { layer: "tool", filters: { scope: "history", projectIds: ["project"] } },
        acceptedRoute: {}, period: "All dates", analytics: {},
        snapshot: { scenarios: [{ projectId: "project", project: name }], sessions: [] },
    });
    assert.deepEqual(value.parts, ["All dates", "Saved collection", `Copilot project: ${name}`]);
    assert.deepEqual(value.restrictions, [`Copilot project: ${name}`]);
    assert.equal(value.text, `All dates; Saved collection; Copilot project: ${name}`);
    assert.equal(value.restrictionText, `Copilot project: ${name}`);
    assert.equal(value.activeCount, 1);
});
