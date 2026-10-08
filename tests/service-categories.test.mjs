import test from "node:test";
import assert from "node:assert/strict";
import { classifyWorkload, OFFICE_WORKLOADS } from "../lib/graph-history.mjs";
import { createServiceCategories, serviceCategories } from "../lib/service-categories.mjs";

test("every classifier category has one concise shared description and stable display label", () => {
    assert.deepEqual(serviceCategories.entries.map((entry) => entry.id), OFFICE_WORKLOADS);
    for (const entry of serviceCategories.entries) {
        assert.ok(entry.description.split(/\s+/).length <= 25, entry.id);
        assert.equal(serviceCategories.describe(entry.id), entry);
        assert.equal(serviceCategories.describe(entry.label), entry);
        assert.equal(Object.isFrozen(entry), true);
    }
    const browserFactory = Function(`return (${createServiceCategories.toString()})()`)();
    assert.deepEqual(browserFactory.entries, serviceCategories.entries);
});

test("descriptions follow actual workload mappings without claiming outcomes or direct execution", () => {
    for (const [path, category] of [
        ["/me/messages", "Mail"], ["/me/events", "Calendar"], ["/sites/{id}/lists", "Files"],
        ["/me/onlineMeetings", "Teams"], ["/users/{id}/presence", "People"], ["/me/todo/lists", "Files"],
        ["/planner/plans", "Tasks"], ["/me/onenote/pages", "Notes"], ["/groups", "Directory"],
        ["/search/query", "Search"], ["/$batch", "Platform metadata"], ["/unclassified", "Unknown"],
    ]) assert.equal(classifyWorkload(path), category);
    assert.equal(classifyWorkload(null, "workiq-retrieve"), "Search");
    assert.equal(classifyWorkload(null, null, ["/me/events", "/unclassified"]), "Multiple workloads");
    assert.match(serviceCategories.describe("Search").description, /multiple sources, not necessarily a direct Graph request/);
    assert.match(serviceCategories.describe("Multiple workloads").description, /could not be identified/);
    assert.match(serviceCategories.describe("Platform metadata").description, /does not describe each batch operation/);
    assert.match(serviceCategories.describe("Unknown").description, /does not mean the call failed/);
    assert.doesNotMatch(serviceCategories.describe("Unknown").description, /API failure|succeeded|task.*correct/i);
});

test("unknown fallback is safe and Other describes only a real supplied count", () => {
    assert.equal(serviceCategories.describe("future-category"), serviceCategories.describe("Unknown"));
    assert.equal(serviceCategories.describe("<script>private value</script>"), serviceCategories.describe("Unknown"));
    assert.match(serviceCategories.describe("Other").description, /^Additional categories/);
    assert.match(serviceCategories.describe("Other (4 groups)", 4).description, /^4 additional categories/);
    assert.match(serviceCategories.describe("group:other", 1).description, /^1 additional category is/);
    assert.throws(() => serviceCategories.describe("Other", 0), /positive category count/);
    assert.deepEqual(serviceCategories.used(["Calendar", "Calendar", "Search", "unmapped"]).map((entry) => entry.id), ["Calendar", "Search", "Unknown"]);
    assert.deepEqual(serviceCategories.used([]), []);
});
