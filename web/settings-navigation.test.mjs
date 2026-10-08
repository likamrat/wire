import test from "node:test";
import assert from "node:assert/strict";
import { createSettingsNavigation } from "./settings-navigation.mjs";
import { createLocalSearch } from "./local-search.mjs";

test("settings canonical routes preserve legacy display/history/issues and explicit fallback", () => {
    const model = createSettingsNavigation(createLocalSearch());
    assert.deepEqual(model.resolve({}), { section: "connection", setting: undefined, warning: "" });
    assert.equal(model.resolve({ section: "display" }).section, "display");
    assert.equal(model.categories.find(category => category.id === "display").title, "Time zone");
    assert.equal(model.resolve({ section: "history" }).setting, "history-window");
    assert.deepEqual(model.resolve({ section: "display", issues: "1" }), { view: "collection-status", section: undefined, setting: "issues", warning: "" });
    assert.match(model.resolve({ section: "absent" }).warning, /Unknown.*Connection/);
    assert.equal(model.resolve({ section: "absent" }).section, "connection");
    assert.equal(model.resolve({ section: "display", setting: "cadence" }).section, "collection");
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
    assert.deepEqual(model.categories.map(row => row.id), ["display", "connection", "collection", "data"]);
});

test("settings search finds control descriptions and synonyms across categories without private paths", () => {
    const model = createSettingsNavigation(createLocalSearch());
    for (const [query, id] of [["TIME-zone", "time-zone"], ["city", "time-zone"], ["pause", "collection-state"], ["resume", "collection-state"], ["permission", "source"], ["cadence", "cadence"], ["window", "history-window"], ["missing history", "issues"]]) {
        assert.ok(model.find(query).some(entry => entry.id === id), query);
    }
    assert.equal(model.find("").length, 0);
    assert.equal(model.find("not-a-real-setting <img>").length, 0);
    assert.equal(model.find("PRIVATE_SOURCE_PATH").length, 0);
    assert.equal(model.find("cadence").find(entry => entry.id === "cadence").category, "Collection preferences");
    assert.equal(model.find("display").find(entry => entry.id === "time-zone").category, "Time zone");
});

test("old optional-evidence links resolve to response saving in Collection preferences", () => {
    const model = createSettingsNavigation(createLocalSearch());
    assert.deepEqual(model.resolve({ section: "evidence" }), { section: "collection", setting: "assessment-evidence", warning: "" });
    assert.deepEqual(model.resolve({ section: "evidence", setting: "assessment-evidence" }), { section: "collection", setting: "assessment-evidence", warning: "" });
    assert.equal(model.find("response").find(entry => entry.id === "assessment-evidence").category, "Collection preferences");
    assert.equal(model.categories.some(category => category.id === "evidence"), false);
});
