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
    assert.match(serviceCategories.describe("Search").description, /tool name alone does not identify the services searched/);
    assert.match(serviceCategories.describe("Discovery").description, /does not run the data operation/);
    assert.match(serviceCategories.describe("Multiple workloads").description, /could not be identified/);
    assert.match(serviceCategories.describe("Platform metadata").description, /does not describe each batch operation/);
    assert.match(serviceCategories.describe("Unknown").description, /does not mean the call failed/);
    assert.match(serviceCategories.describe("Unknown").description, /missing a usable service target.*cannot classify its path/);
    assert.doesNotMatch(serviceCategories.describe("Unknown").description, /routing may be hidden/);
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

test("requested retrieval scope uses only supported capability names and never implies returned sources", () => {
    const call = capabilities => ({ tool: "workiq-retrieve", requestArgs: { capabilities } });
    const names = ["TeamsMessages", "Email", "People", "Meetings", "OneDriveAndSharePoint", "Dataverse", "GraphConnectors"];
    const labels = ["Teams messages", "email", "people", "meetings", "OneDrive and SharePoint", "Dataverse", "connected sources"];
    for (const [index, name] of names.entries()) {
        const scope = serviceCategories.requestedSearchScope(call([{ name }]));
        assert.equal(scope.label, `Requested sources: ${labels[index]}`);
        assert.equal(scope.description, "", "A concrete requested-source label needs no generic result caveat");
    }
    const input = call([{ name: "TeamsMessages", urls: [{ url: "PRIVATE-URL" }] }, { name: "Email" }, { name: "TeamsMessages" }]);
    const before = structuredClone(input);
    const scope = serviceCategories.requestedSearchScope(input);
    assert.equal(scope.label, "Requested sources: Teams messages and email");
    assert.deepEqual(input, before);
    assert.doesNotMatch(JSON.stringify(scope), /PRIVATE-URL/);
    for (const capabilities of [undefined, null, []]) assert.equal(serviceCategories.requestedSearchScope(call(capabilities)), null);
    assert.equal(serviceCategories.requestedSearchScope({ ...input, tool: "workiq-ask" }), null);
    for (const capabilities of ["PRIVATE", {}, [null], ["Email"], [{ name: "PRIVATE" }], [{ name: "email" }], [[]]]) {
        const unsupported = serviceCategories.requestedSearchScope(call(capabilities));
        assert.equal(unsupported.label, "Requested sources not identified");
        assert.equal(unsupported.description, "The recorded source choices are not recognized.");
        assert.doesNotMatch(JSON.stringify(unsupported), /PRIVATE/);
    }
    const partial = serviceCategories.requestedSearchScope(call([{ name: "Email" }, { name: "PRIVATE" }]));
    assert.equal(partial.label, "Requested sources: email");
    assert.equal(partial.description, "Some requested sources could not be identified.");
    assert.doesNotMatch(partial.description, /results|returned/);
    for (const toolSucceeded of [true, false, null]) {
        assert.deepEqual(serviceCategories.requestedSearchScope({ ...input, toolSucceeded }), scope,
            "A requested source choice must not acquire a result claim from the call's outcome");
    }
    const browser = Function(`return (${createServiceCategories.toString()})()`)();
    assert.deepEqual(browser.requestedSearchScope(input), scope);
});
