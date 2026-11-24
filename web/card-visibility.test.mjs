import test from "node:test";
import assert from "node:assert/strict";
import { createCardVisibility } from "./card-visibility.mjs";

test("new hides use their own lifetime; restore only touches currently admitted cards", () => {
    const storage = () => {
        const values = new Map();
        return { get length() { return values.size; }, key: i => [...values.keys()][i], getItem: key => values.get(key) ?? null,
            setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    };
    const host = { localStorage: storage(), sessionStorage: storage(), addEventListener() {} };
    const prefs = createCardVisibility(host, () => {});
    const row = n => ({ scenarioId: `private-${n}`, cardVisibilityRef: `card-${"0".repeat(31)}${n}` });
    const snapshot = { namedDrafts: { source: "first" }, scenarios: [row(1), row(2)] };
    prefs.bind(snapshot); prefs.hide("private-1", "manual"); prefs.hide("private-2", "tab");
    const other = createCardVisibility({ ...host, sessionStorage: storage() }, () => {});
    other.bind(snapshot); assert.equal(other.has("private-1"), true); assert.equal(other.has("private-2"), false);
    prefs.bind({ ...snapshot, namedDrafts: { source: "other" } }); assert.equal(prefs.has("private-1"), false);
    prefs.bind({ scenarios: snapshot.scenarios }); assert.equal(prefs.has("private-1"), true); assert.deepEqual(prefs.entries(), []);
    prefs.bind({ ...snapshot, scenarios: [row(2)] }); prefs.restore(prefs.entries().map(x => x.ref));
    prefs.bind(snapshot); assert.equal(prefs.has("private-1"), true); assert.equal(prefs.has("private-2"), false);
});
