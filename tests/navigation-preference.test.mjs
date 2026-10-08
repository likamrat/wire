import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { initializeNavigationPreference } from "../web/sidebar-navigation.mjs";

function fixture({ stored = null, readError, writeError } = {}) {
    const root = { dataset: {} }, warnings = [], writes = [], events = new Map();
    const storage = {
        getItem(key) { assert.equal(key, "workiq-evidence.navigation"); if (readError) throw readError; return stored; },
        setItem(key, value) { assert.equal(key, "workiq-evidence.navigation"); if (writeError) throw writeError; writes.push(value); stored = value; },
    };
    const navigation = runInNewContext(`(${initializeNavigationPreference.toString()})()`, {
        document: { documentElement: root },
        window: { localStorage: storage, addEventListener: (type, fn) => events.set(type, fn) },
        console: { warn: text => warnings.push(text) },
    });
    let state;
    navigation.subscribe(value => { state = value; });
    return { navigation, root, writes, warnings, get state() { return state; },
        recover() { readError = writeError = undefined; },
        storageEvent(value, options = {}) { events.get("storage")({ key: "workiq-evidence.navigation", storageArea: storage, newValue: value, ...options }); } };
}

test("navigation starts expanded or restores the exact display choice before paint without rewriting storage", () => {
    for (const stored of [null, "expanded", "collapsed", "unrecognized"]) {
        const value = fixture({ stored }), expected = stored === "collapsed" ? "collapsed" : "expanded";
        assert.equal(value.state.preference, expected);
        assert.equal(value.root.dataset.navigation, expected);
        assert.deepEqual(value.writes, []);
        assert.equal(value.warnings.length, stored === "unrecognized" ? 1 : 0);
        value.navigation.setPreference(expected === "expanded" ? "collapsed" : "expanded");
        assert.equal(value.writes.length, 1);
    }
});

test("only valid same-origin preference events update navigation without a write loop", () => {
    const value = fixture({ stored: "collapsed" });
    for (const invalid of [null, "", false, "other"]) {
        assert.throws(() => value.navigation.setPreference(invalid), /Choose expanded or collapsed/);
        value.storageEvent(invalid);
        assert.equal(value.state.preference, "collapsed");
    }
    value.storageEvent("expanded", { key: "unrelated" });
    value.storageEvent("expanded", { storageArea: {} });
    assert.equal(value.state.preference, "collapsed");
    value.storageEvent("expanded");
    assert.equal(value.root.dataset.navigation, "expanded");
    assert.deepEqual(value.writes, []);
});

test("known storage failures surface panel-only state and recover on the next explicit choice", () => {
    for (const name of ["SecurityError", "QuotaExceededError"]) for (const failure of ["readError", "writeError"]) {
        const error = new DOMException("Synthetic storage failure", name);
        const value = fixture({ [failure]: error, writeError: error });
        value.navigation.setPreference("collapsed");
        assert.equal(value.state.preference, "collapsed");
        assert.equal(value.state.storageUnavailable, true);
        assert.ok(value.warnings.length > 0);
        value.storageEvent("expanded");
        assert.equal(value.state.preference, "collapsed");
        value.recover();
        value.navigation.setPreference("expanded");
        assert.equal(value.state.storageUnavailable, false);
        assert.deepEqual(value.writes, ["expanded"]);
    }
    assert.throws(() => fixture({ readError: new Error("Unexpected storage error") }), /Unexpected storage error/);
    assert.throws(() => fixture({ writeError: new Error("Unexpected storage error") }).navigation.setPreference("collapsed"), /Unexpected storage error/);
});
