import test from "node:test";
import assert from "node:assert/strict";
import { createTimeContext } from "../lib/time.mjs";

const time = createTimeContext();
const device = time.normalize({ timeZone: "America/Los_Angeles", locale: "en-US" });

test("display timezone defaults to device, canonicalizes overrides and resets without mutating context", () => {
    assert.deepEqual(time.resolve(null, device), device);
    for (const name of ["UTC", "Asia/Kolkata", "America/Los_Angeles"]) {
        assert.deepEqual(time.resolve(name, device), { ...device, timeZone: time.zone(name) });
    }
    assert.deepEqual(time.resolve(null, device), device);
    assert.equal(device.timeZone, "America/Los_Angeles");
    for (const name of ["PST", "CST", "GMT+5:30", "America/NotAZone", "", 2]) assert.throws(() => time.resolve(name, device));
    const fallback = time.normalize();
    assert.equal(time.resolve("Asia/Kolkata", fallback).timeZoneFallback, false);
    assert.equal(time.resolve(null, fallback).timeZoneFallback, true);
});

test("central context uses a readable identity rather than today's offset or ambiguous abbreviation", () => {
    assert.equal(time.displayLabel(device), "Los Angeles time");
    assert.equal(time.displayLabel({ timeZone: "UTC" }), "UTC");
    assert.equal(time.displayLabel(time.normalize()), "UTC (fallback)");
    assert.equal(time.displayLabel({ timeZone: "Etc/GMT+5" }), "Etc/GMT+5", "Do not reverse the IANA fixed-offset meaning by dropping Etc/");
    assert.match(time.displayLabel({ timeZone: "Asia/Kolkata" }), /Kolkata|Calcutta/);
    assert.doesNotMatch(time.displayLabel(device), /PST|PDT|GMT|UTC-/);
    const { available, zones } = time.zoneChoices(device);
    assert.equal(available, true);
    assert.ok(zones.some(z => z.timeZone === "UTC"));
    assert.ok(zones.some(z => z.timeZone === "America/Los_Angeles"));
    assert.equal(zones.length, new Set(zones.map(z => z.timeZone)).size);
    assert.ok(zones.every(z => z.label.includes(z.timeZone)));
});

test("a missing zone-list capability leaves validated device and UTC options with explicit availability", () => {
    const native = Intl.supportedValuesOf;
    try {
        Intl.supportedValuesOf = undefined;
        const choices = time.zoneChoices(device);
        assert.equal(choices.available, false);
        assert.deepEqual(choices.zones.map(z => z.timeZone).sort(), ["America/Los_Angeles", "UTC"]);
    } finally { Intl.supportedValuesOf = native; }
});
