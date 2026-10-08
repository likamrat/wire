import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { initializeTheme } from "../web/theme.mjs";

const key = "workiq-evidence.theme";

function fixture({ stored = null, rootHost = null, bodyHost = null, dark = false, mediaAvailable = true, readError, writeError } = {}) {
    const root = { dataset: {}, getAttribute: () => rootHost };
    const body = { getAttribute: () => bodyHost };
    const writes = [], warnings = [], events = new Map();
    const storage = {
        getItem(name) { assert.equal(name, key); if (readError) throw readError; return stored; },
        setItem(name, value) { assert.equal(name, key); if (writeError) throw writeError; stored = value; writes.push(value); },
    };
    const media = { matches: dark, addEventListener() { assert.fail("Theme must not follow OS changes"); } };
    const window = { localStorage: storage, addEventListener: (name, callback) => events.set(name, callback) };
    if (mediaAvailable) window.matchMedia = () => media;
    const theme = runInNewContext(`(${initializeTheme.toString()})()`, {
        window, document: { documentElement: root, body }, console: { warn: (message) => warnings.push(message) },
    });
    let state;
    theme.subscribe((value) => { state = value; });
    return {
        theme, root, writes, warnings,
        get state() { return state; }, get stored() { return stored; },
        changeEnvironment() { rootHost = rootHost === "dark" ? "light" : "dark"; bodyHost = "dark"; media.matches = !media.matches; },
        storageEvent(value, options = {}) { events.get("storage")({ storageArea: storage, key, newValue: value, ...options }); },
        recoverStorage() { readError = undefined; writeError = undefined; },
    };
}

test("explicit saved choices win over host/OS and are not rewritten on initialization", () => {
    for (const stored of ["light", "dark"]) {
        const value = fixture({ stored, rootHost: stored === "light" ? "dark" : "light", dark: stored === "light" });
        assert.equal(value.state.preference, stored);
        assert.equal(value.root.dataset.evidenceTheme, stored);
        assert.deepEqual(value.writes, []);
        value.changeEnvironment();
        assert.equal(value.state.theme, stored);
    }
});

test("legacy, unset and invalid values migrate once in root/body/OS/fallback priority", () => {
    for (const stored of ["system", null, "invalid"]) for (const [environment, expected] of [
        [{ rootHost: "dark", bodyHost: "light", dark: false }, "dark"],
        [{ rootHost: "light", bodyHost: "dark", dark: true }, "light"],
        [{ rootHost: "invalid", bodyHost: "dark", dark: false }, "dark"],
        [{ rootHost: "invalid", bodyHost: "light", dark: true }, "light"],
        [{ rootHost: "invalid", bodyHost: "invalid", dark: true }, "dark"],
        [{ dark: false }, "light"],
        [{ mediaAvailable: false }, "light"],
    ]) {
        const value = fixture({ stored, ...environment });
        assert.equal(value.state.preference, expected);
        assert.equal(value.stored, expected);
        assert.deepEqual(value.writes, [expected]);
        assert.equal(value.warnings.length, stored === "invalid" ? 1 : 0);
        value.changeEnvironment();
        assert.equal(value.state.theme, expected);
        assert.deepEqual(value.writes, [expected]);
        const reload = fixture({ stored: value.stored, dark: expected !== "dark" });
        assert.equal(reload.state.theme, expected);
        assert.deepEqual(reload.writes, []);
    }
});

test("only explicit choices can be set or accepted from same-origin storage events", () => {
    const value = fixture({ stored: "dark" });
    for (const invalid of ["system", "DARK", "", null, undefined, 0]) {
        assert.throws(() => value.theme.setPreference(invalid), /Choose Light or Dark/);
        value.storageEvent(invalid);
        assert.equal(value.state.preference, "dark");
    }
    value.storageEvent(null, { key: null });
    value.storageEvent("light", { key: "unrelated" });
    value.storageEvent("light", { storageArea: {} });
    assert.equal(value.state.preference, "dark");
    value.storageEvent("light");
    assert.equal(value.state.preference, "light");
    assert.equal(value.root.dataset.evidenceThemePreference, "light");
    assert.deepEqual(value.writes, [], "Receiving a storage event must not create a write loop");
    value.theme.setPreference("dark");
    assert.deepEqual(value.writes, ["dark"]);
});

test("known storage failures keep a concrete local appearance and recover on an explicit toggle", () => {
    for (const [property, name] of [["readError", "SecurityError"], ["writeError", "QuotaExceededError"]]) {
        const value = fixture({ dark: true, [property]: new DOMException("Synthetic storage failure", name) });
        assert.equal(value.state.preference, "dark");
        assert.equal(value.state.storageUnavailable, true);
        assert.equal(value.warnings.length, 1);
        value.storageEvent("light");
        assert.equal(value.state.preference, "dark");
        value.theme.setPreference("light");
        assert.equal(value.state.theme, "light");
        value.recoverStorage();
        value.theme.setPreference("dark");
        assert.equal(value.state.storageUnavailable, false);
        assert.equal(value.stored, "dark");
    }
});

test("unexpected storage errors are not hidden by appearance fallback", () => {
    assert.throws(() => fixture({ readError: new Error("Unexpected read failure") }), /Unexpected read failure/);
    assert.throws(() => fixture({ writeError: new Error("Unexpected write failure") }), /Unexpected write failure/);
});
