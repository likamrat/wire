import test from "node:test";
import assert from "node:assert/strict";
import { createFilterState } from "../web/client.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { createPromptAuthorship } from "../lib/prompt-authorship.mjs";

const filters = createFilterState(createRecordedResults(), createPromptAuthorship());

test("association routes stay distinct from legacy categories and preserve explicit strict scope", () => {
    assert.deepEqual(filters.query({ service: "Files" }), { scope: "history", includeMetadata: false, workloads: ["Files"] });
    assert.deepEqual(filters.query(filters.canonical({ services: "Mail,Files,Mail", includeMissingService: "false", tool: "workiq-fetch" })), {
        scope: "history", includeMetadata: false, tools: ["workiq-fetch"], services: ["Files", "Mail"], includeMissingService: false,
    });

    assert.deepEqual(filters.query({ services: "Files" }), { scope: "history", includeMetadata: false, services: ["Files"] });
    assert.equal(filters.query(filters.canonical({ services: "Files", includeMissingService: "true" })).includeMissingService, true);
    assert.equal(filters.canonical({ includeMissingService: "true" }).includeMissingService, undefined);
    assert.equal(filters.query(filters.canonical({ services: "Files", includeMissingService: "invalid" })).includeMissingService, "invalid",
        "Invalid explicit state reaches normal query validation; it never silently becomes strict or All.");
});

test("scoped chat navigation retains all analytical filters but not paging or private search", () => {
    const route = { view: "home", tool: "workiq-fetch", services: "Files", includeMissingService: false, service: "Multiple workloads",
        project: "invented-project", result: "failure,unknown", authors: "user,agent", layer: "tool", scope: "all",
        range: "custom", from: "2026-10-01", to: "2026-10-02", bucket: "day", endpoint: "invented-endpoint",
        page: "2", search: "private text", request: "old-request" };
    const scoped = filters.scope(route, { view: "activity", session: "invented-chat" });
    assert.equal(scoped.page, undefined);
    assert.equal(scoped.search, undefined);
    assert.equal(scoped.request, undefined);
    assert.equal(scoped.includeMissingService, false);
    assert.deepEqual(filters.query(scoped), { ...filters.query(route), sourceSessionIds: ["invented-chat"] });
    assert.equal(scoped.bucket, "day");
    assert.equal(filters.scope(route, { view: "activity", result: "success" }).result, "success", "Explicit result links override only their named field.");
});
