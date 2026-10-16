import test from "node:test";
import assert from "node:assert/strict";
import { createSettingsNavigation } from "./settings-navigation.mjs";
import { createLocalSearch } from "./local-search.mjs";

test("settings canonical routes preserve legacy display/history/issues and explicit fallback", () => {
    const model = createSettingsNavigation(createLocalSearch());
    assert.deepEqual(model.resolve({}), { section: "connection", setting: undefined, warning: "" });
    assert.equal(model.resolve({ section: "display" }).section, "display");
    assert.equal(model.categories.find(category => category.id === "display").title, "Display");
    assert.equal(model.resolve({ section: "history" }).setting, "history-window");
    assert.deepEqual(model.resolve({ section: "display", issues: "1" }), { view: "collection-status", section: undefined, setting: "issues", warning: "" });
    assert.match(model.resolve({ section: "absent" }).warning, /Unknown.*Connection/);
    assert.equal(model.resolve({ section: "absent" }).section, "connection");
    assert.equal(model.resolve({ section: "display", setting: "cadence" }).section, "connection");
});

test("operational destinations leave Settings and preserve named legacy targets", () => {
    const model = createSettingsNavigation(createLocalSearch());
    for (const route of [{ section: "diagnostics" }, { setting: "issues" }, { setting: "advanced" }, { view: "collection-status" }]) {
        assert.equal(model.resolve(route).view, "collection-status");
        assert.equal(model.resolve(route).section, undefined);
    }
    assert.equal(model.resolve({ setting: "advanced" }).setting, "collection-details");
    assert.equal(model.find("missing history").find(entry => entry.id === "issues").view, "collection-status");
    assert.equal(model.find("status").find(entry => entry.id === "collection-details").category, "Collection status");
    assert.deepEqual(model.categories.map(row => row.title), ["Connection & updates", "Privacy & saved data", "AI reviews", "Display", "Troubleshooting"]);
});

test("settings search finds control descriptions and synonyms across categories without private paths", () => {
    const model = createSettingsNavigation(createLocalSearch());
    for (const [query, id] of [["glide", "sidebar-motion"], ["TIME-zone", "time-zone"], ["city", "time-zone"], ["pause", "collection-state"], ["resume", "collection-state"], ["permission", "source"], ["cadence", "cadence"], ["window", "history-window"], ["missing history", "issues"]]) {
        assert.ok(model.find(query).some(entry => entry.id === id), query);
    }
    assert.equal(model.find("").length, 0);
    assert.equal(model.find("not-a-real-setting <img>").length, 0);
    assert.equal(model.find("PRIVATE_SOURCE_PATH").length, 0);
    assert.equal(model.find("cadence").find(entry => entry.id === "cadence").category, "Connection & updates");
    assert.equal(model.find("display").find(entry => entry.id === "time-zone").category, "Display");
});

test("old optional-evidence links resolve to response saving in Privacy and saved data", () => {
    const model = createSettingsNavigation(createLocalSearch());
    assert.deepEqual(model.resolve({ section: "evidence" }), { section: "privacy", setting: "assessment-evidence", warning: "" });
    assert.deepEqual(model.resolve({ section: "evidence", setting: "assessment-evidence" }), { section: "privacy", setting: "assessment-evidence", warning: "" });
    assert.equal(model.find("response").find(entry => entry.id === "assessment-evidence").category, "Privacy & saved data");
    assert.equal(model.categories.some(category => category.id === "evidence"), false);
});

test("all fourteen old setting IDs and explicit category aliases keep their actual destinations", () => {
    const model = createSettingsNavigation(createLocalSearch());
    const old = {
        "automatic-scores": ["ai", "automaticScoreReview"], "assessment-evidence": ["privacy", "assessmentSetupTitle"],
        "delete-activity": ["privacy", "deleteActivity"], "recollect-activity": ["privacy", "recollectActivity"],
        "time-zone": ["display", "displayTimeZone"], source: ["connection", "reviewSource"],
        "collection-state": ["connection", "pauseCollection"], "collect-now": ["connection", "checkActivity"],
        "source-paths": ["connection", "approvedSourceDetails"], "history-window": ["connection", "collectionWindow"],
        cadence: ["connection", "collectionCadence"], "save-preferences": ["connection", "saveCollection"],
        issues: ["collection-status", "collectionIssuesTitle"], "collection-details": ["collection-status", "collectionSetup"],
    };
    for (const [id, [destination, target]] of Object.entries(old)) {
        const entry = model.entries.find(value => value.id === id);
        assert.equal(entry.target, target, id);
        const resolved = model.resolve({ section: "collection", setting: id });
        assert.equal(resolved.view || resolved.section, destination, id);
        assert.equal(resolved.setting, id);
        assert.equal(resolved.warning, "");
    }
    for (const [section, expected] of Object.entries(model.sectionAliases)) {
        assert.deepEqual(model.resolve({ section }), { ...expected, warning: "" });
    }
    assert.equal(new Set(model.entries.map(entry => entry.id)).size, model.entries.length);
    for (const entry of model.entries) {
        assert.ok(entry.view === "collection-status" || model.categories.some(row => row.id === entry.section));
        assert.ok(model.find(entry.title).some(row => row.id === entry.id), entry.id);
    }
});

test("humanized Settings names retain previous search phrases and destination IDs", () => {
    const model = createSettingsNavigation(createLocalSearch());
    for (const [id, queries] of [
        ["delete-activity", ["Delete collected activity", "Review deletion"]],
        ["recollect-activity", ["Recollect activity", "Recollect from approved sources", "Read history again", "Choose chats"]],
        ["history-window", ["Initial history window", "History to include"]],
        ["service-provenance", ["Service details", "How services are identified"]],
        ["author-provenance", ["Prompt authors", "How prompt authors are identified"]],
        ["settings-search", ["Search troubleshooting", "Missing search results"]],
    ]) for (const query of queries) {
        assert.ok(model.find(query).some(entry => entry.id === id), `${query} finds ${id}`);
        assert.equal(model.resolve({ setting: id }).setting, id);
    }
});
