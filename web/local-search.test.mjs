import test from "node:test";
import assert from "node:assert/strict";
import { createLocalSearch } from "./local-search.mjs";

test("local search handles case, spacing and punctuation as literal words", () => {
    const search = createLocalSearch();
    assert.equal(search.matches("TIME-zone", ["Display time zone"]), true);
    assert.equal(search.matches("cafe", ["Caf\u00e9"]), true);
    assert.equal(search.matches("[.*] <img>", ["Display time zone"]), false);
    assert.equal(search.matches("[.*] <img>", ["Literal [.*] <img> title"]), true);
    assert.equal(search.matches("!!!", ["Any setting"]), false);
    assert.equal(search.matches(" ", ["Any setting"]), true);
});

test("Activity phrase matching does not widen a specific numbered request into unrelated words", () => {
    const search = createLocalSearch();
    assert.equal(search.phrase("Synthetic request 2.1:", ["Synthetic request 2.1: details"]), true);
    assert.equal(search.phrase("Synthetic request 2.1:", ["Synthetic request 1.2: details", "Chat 21"]), false);
    assert.equal(search.phrase("ZEPHYR-end <img>", ["Zephyr end <img> chat"]), true);
});

test("highlight parts preserve exact literal text without generating HTML", () => {
    const search = createLocalSearch(), text = "Time-zone <img> Caf\u00e9";
    const parts = search.parts(text, "TIME cafe <img>");
    assert.equal(parts.map(part => part.text).join(""), text);
    assert.deepEqual(parts.filter(part => part.match).map(part => part.text), ["Time", "img", "Caf\u00e9"]);
});
