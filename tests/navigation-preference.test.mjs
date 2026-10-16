import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { initializeNavigationPreference, initializeSidebarMotionPreference } from "../web/sidebar-navigation.mjs";

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

function motionFixture({ stored = null, reduced = true, readError, writeError } = {}) {
    const root = { dataset: {} }, warnings = [], writes = [], events = new Map();
    let mediaChange, state;
    const media = { matches: reduced, addEventListener: (type, listener) => { mediaChange = listener; } };
    const storage = {
        getItem(key) { assert.equal(key, "workiq-evidence.sidebar-motion"); if (readError) throw readError; return stored; },
        setItem(key, value) { assert.equal(key, "workiq-evidence.sidebar-motion"); if (writeError) throw writeError; writes.push(value); stored = value; },
        removeItem(key) { assert.equal(key, "workiq-evidence.sidebar-motion"); if (writeError) throw writeError; writes.push(null); stored = null; },
    };
    const motion = runInNewContext(`(${initializeSidebarMotionPreference.toString()})()`, {
        document: { documentElement: root }, matchMedia: () => media,
        window: { localStorage: storage, addEventListener: (type, listener) => events.set(type, listener) },
        console: { warn: text => warnings.push(text) },
    });
    motion.subscribe(value => { state = value; });
    return { motion, root, writes, warnings, get state() { return state; },
        reduce(value) { media.matches = value; mediaChange(); },
        recover() { readError = writeError = undefined; },
        storageEvent(value, extra = {}) { events.get("storage")({ key: "workiq-evidence.sidebar-motion", storageArea: storage, newValue: value, ...extra }); },
    };
}

test("one sidebar policy restores On/Off before paint and otherwise follows system without saving an override", () => {
    for (const reduced of [false, true]) for (const stored of [null, "system", "on", "off", "invalid"]) {
        const value = motionFixture({ stored, reduced });
        const expected = stored === "on" || stored !== "off" && !reduced;
        assert.equal(value.motion.enabled, expected);
        assert.equal(value.state.enabled, expected);
        assert.equal(value.root.dataset.sidebarMotion, expected ? "on" : "off");
        assert.deepEqual(value.writes, []);
        value.reduce(!reduced);
        assert.equal(value.motion.enabled, stored === "on" || stored !== "off" && reduced);
        if (stored === "invalid") assert.match(value.state.warning, /invalid.*Following the system/);
    }
});

test("sidebar policy shares exact same-origin changes, ignores unrelated storage, and resets to system on removal", () => {
    const value = motionFixture();
    value.motion.setPreference("on");
    assert.equal(value.state.enabled, true);
    value.reduce(true);
    assert.equal(value.state.enabled, true);
    value.storageEvent("off", { storageArea: {} });
    value.storageEvent("off", { key: "unrelated" });
    assert.equal(value.state.preference, "on");
    value.storageEvent("off");
    assert.equal(value.state.enabled, false);
    value.storageEvent(null);
    assert.equal(value.state.preference, "system");
    value.reduce(false);
    assert.equal(value.state.enabled, true);
    value.motion.setPreference("off");
    value.storageEvent(null, { key: null });
    assert.equal(value.state.preference, "system");
    value.motion.setPreference("system");
    assert.deepEqual(value.writes, ["on", "off", null]);
    assert.throws(() => value.motion.setPreference("always"), /Choose Follow system/);
});

test("sidebar storage denial is explicit, panel-local and recoverable without hiding unexpected errors", () => {
    for (const name of ["SecurityError", "QuotaExceededError"]) {
        const error = new DOMException("Synthetic denial", name);
        const value = motionFixture({ readError: error, writeError: error });
        assert.equal(value.state.enabled, false);
        assert.match(value.state.warning, /panel only until reload/);
        value.motion.setPreference("on");
        assert.equal(value.state.enabled, true);
        assert.match(value.state.warning, /panel only until reload/);
        assert.ok(value.warnings.length > 0);
        value.recover();
        value.motion.setPreference("off");
        assert.equal(value.state.warning, "");
        assert.deepEqual(value.writes, ["off"]);
    }
    assert.throws(() => motionFixture({ readError: new Error("Unexpected") }), /Unexpected/);
    assert.throws(() => motionFixture({ writeError: new Error("Unexpected") }).motion.setPreference("on"), /Unexpected/);
});
