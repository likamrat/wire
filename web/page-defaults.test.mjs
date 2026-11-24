import test from "node:test";
import assert from "node:assert/strict";
import { createPageDefaults, pageDefaultSpecs } from "./page-defaults.mjs";

test("only valid defaults survive reload; an unavailable write applies to this panel only", () => {
    const values = new Map(), host = { localStorage: {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
    }, addEventListener() {} };
    const load = () => createPageDefaults(pageDefaultSpecs, host);
    const prefs = load();
    prefs.set("reportFormats", ["markdown", "pdf"]);
    assert.deepEqual(load().get("reportFormats"), ["pdf", "markdown"]);
    const original = pageDefaultSpecs.analyzeLayout.initial, reverse = original.toReversed();
    prefs.set("analyzeLayout", reverse);
    assert.deepEqual(load().get("analyzeLayout"), reverse);
    for (const invalid of [reverse.slice(1), [...reverse, "unknown"], reverse.map(() => "time")]) {
        values.set("wire.page-defaults.v1.analyzeLayout", JSON.stringify(invalid));
        assert.deepEqual(load().get("analyzeLayout"), original);
        assert.match(load().message("analyzeLayout"), /invalid/i);
    }
    prefs.set("reportFormats", []);
    assert.deepEqual(prefs.get("reportFormats"), ["pdf", "markdown"]);
    assert.match(prefs.message("reportFormats"), /at least one/i);
    values.set("wire.page-defaults.v1.trendChart", '"obsolete"');
    assert.equal(load().get("trendChart"), "problems");
    assert.match(load().message("trendChart"), /invalid/i);
    values.set("wire.page-defaults.v1.guideStart", '"index"');
    assert.equal(load().get("guideStart"), "outcomes");
    assert.equal(load().message("guideStart"), "");
    prefs.set("guideStart", "last");
    assert.equal(load().get("guideStart"), "last");
    host.localStorage.setItem = () => { throw new DOMException("Full", "QuotaExceededError"); };
    prefs.set("analyzeRange", "30");
    assert.equal(prefs.get("analyzeRange"), "30");
    assert.match(prefs.message("analyzeRange"), /this panel only/i);
    assert.equal(load().get("analyzeRange"), "capture");
});
