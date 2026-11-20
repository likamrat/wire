import test from "node:test";
import assert from "node:assert/strict";
import { createAnalyzeTrendsEntry } from "./analyze-trends-entry.mjs";
import { time } from "../lib/time.mjs";
import { promptAuthorship } from "../lib/prompt-authorship.mjs";
import { serviceCategories } from "../lib/service-categories.mjs";
import { createRecordedResults } from "./recorded-results.mjs";

const { project } = createAnalyzeTrendsEntry({ time, results: createRecordedResults(), authorship: promptAuthorship, categories: serviceCategories });
const ctx = { scope: { timeContext: { timeZone: "America/Toronto", locale: "en-CA" }, layer: "tool", bucket: "day",
    filters: { scope: "all", from: "2026-10-12", to: "2026-11-12" } }, revision: 12, route: {}, supportedTools: new Set(["workiq-fetch"]) };

test("native groups, Search, a prior collection, project/chat/path, unsupported tool and grouping need specific consent without echoing private values", () => {
    const result = project("rhythm", { ...ctx, hasSearch: true, includesNative: true, hasEarlier: true,
        route: { nativeGroup: "private-name", chart: "endpoint", search: "private-search" },
        scope: { ...ctx.scope, bucket: "week", filters: { ...ctx.scope.filters, scope: "legacy", tools: ["private-native-tool"],
            sources: ["microsoft-365-chat"], endpoints: ["private-path"], projectIds: ["private-project"], sourceSessionIds: ["private-session"] } } });
    const text = result.changes.join("\n");
    for (const phrase of ["Microsoft groups", "Search matches", "both retained collections", "project", "chat or recorder source", "path or operation", "selected tool is unavailable", "one count per calendar day"]) assert.ok(text.includes(phrase), phrase);
    assert.doesNotMatch(JSON.stringify(result), /private-/);
    assert.deepEqual(result.entry.filters, {}); assert.equal(result.entry.period, "custom");
    assert.deepEqual(result.entry.range, { from: "2026-10-12", to: "2026-11-12" });
    assert.deepEqual(result.entry.timeContext, ctx.scope.timeContext);
});
test("service refinement is carried only for compatible involvement; unknown, union and context-only semantics stay explicit", () => {
    const basis = { ...ctx, route: { withinServices: "Mail" } };
    const exact = project("services", basis);
    assert.deepEqual(exact.changes, []); assert.deepEqual(exact.entry.filters, { service: "Mail" });
    assert.equal(exact.entry.series, "Mail");
    for (const selection of [["Unknown"], ["Calendar", "Mail"], ["Multiple workloads"]]) {
        const value = project("services", { ...ctx, scope: { ...ctx.scope, filters: { ...ctx.scope.filters, services: selection } } });
        assert.deepEqual(value.entry.filters, {}); assert.match(value.changes.join(" "), /all services/);
    }
    const missing = project("services", { ...ctx, scope: { ...ctx.scope, filters: { ...ctx.scope.filters, services: ["Mail"], includeMissingService: true } } });
    assert.deepEqual(missing.entry.filters, { service: "Mail" }); assert.match(missing.changes.join(" "), /excludes context-only/);
});
