import test from "node:test";
import assert from "node:assert/strict";
import { time } from "../lib/time.mjs";
import * as comparison from "../web/period-comparison.mjs";

const context = { timeZone: "America/New_York", locale: "en-US" };

test("complete-day starts exclude today and preserve equal civil lengths across zones, DST and leap days", () => {
    const view = comparison.createPeriodComparisonPresentation(time);
    for (const [zone, now] of [["America/New_York", "2026-03-09T15:00:00Z"], ["America/New_York", "2026-11-02T15:00:00Z"],
        ["Pacific/Honolulu", "2026-03-09T03:00:00Z"], ["Pacific/Kiritimati", "2026-03-09T03:00:00Z"],
        ["UTC", "2024-03-01T10:00:00Z"]]) {
        for (const days of [7, 14, 30]) {
            const pair = view.completeDays(days, { ...context, timeZone: zone }, now);
            assert.equal(pair.bTo, time.addDays(time.day(now, zone), -1));
            assert.equal(pair.aTo, time.addDays(pair.bFrom, -1));
            assert.equal(time.addDays(pair.aFrom, days - 1), pair.aTo);
            assert.equal(time.addDays(pair.bFrom, days - 1), pair.bTo);
            assert.ok(time.range({ from: pair.bFrom, to: pair.bTo }, zone).toExclusive);
        }
    }
    assert.throws(() => view.completeDays(8, context), /7, 14 or 30/);
});

test("period presets resolve complete civil weeks and months without inventing custom dates", () => {
    const view = comparison.createPeriodComparisonPresentation(time);
    assert.deepEqual(view.preset("this-week", context, "2026-03-09T15:00:00Z"), { from: "2026-03-09", to: "2026-03-15" });
    assert.deepEqual(view.preset("previous-week", context, "2026-03-09T15:00:00Z"), { from: "2026-03-02", to: "2026-03-08" });
    assert.deepEqual(view.preset("this-month", context, "2024-03-10T15:00:00Z"), { from: "2024-03-01", to: "2024-03-31" });
    assert.deepEqual(view.preset("previous-month", context, "2024-03-10T15:00:00Z"), { from: "2024-02-01", to: "2024-02-29" });
    assert.deepEqual(view.preset("previous-month", context, "2026-01-10T15:00:00Z"), { from: "2025-12-01", to: "2025-12-31" });
    assert.equal(view.preset("custom", context, "2026-03-09T15:00:00Z"), null);
    assert.throws(() => view.preset("unknown", context, "2026-03-09T15:00:00Z"), /preset/i);
});

test("before and after rates keep zero, no denominator and small differences distinct", () => {
    const view = comparison.createPeriodComparisonPresentation(time);
    assert.deepEqual(view.rates({ failure: 3, count: 24 }, { failure: 4, count: 24 }), ["12.50%", "16.67%"]);
    assert.deepEqual(view.rates({ failure: 0, count: 2 }, { failure: 0, count: 0 }), ["0.00%", null]);
    assert.deepEqual(view.rates({ failure: 0, count: 1000000 }, { failure: 1, count: 1000000 }), ["0.0000%", "0.0001%"]);
    assert.deepEqual(view.rates({ failure: 1, count: 1000000 }, { failure: 1, count: 1000000 }), ["0.0001%", "0.0001%"]);
    assert.deepEqual(view.rates({ partial: 1, count: 3 }, { partial: 1, count: 6 }, "partial"), ["33.33%", "16.67%"]);
});

test("period names describe accepted dates in the chosen timezone and distinguish years", () => {
    const view = comparison.createPeriodComparisonPresentation(time), now = "2026-03-09T15:00:00Z";
    assert.deepEqual(view.names([{ from: "2026-03-02", to: "2026-03-08" }, { from: "2026-03-09", to: "2026-03-15" }], context, now),
        [{ label: "Previous week", phrase: "the previous week", preset: "previous-week" },
            { label: "This week", phrase: "this week", preset: "this-week" }]);
    const names = view.names([{ from: "2025-03-07", to: "2025-03-07" }, { from: "2026-03-07", to: "2026-03-07" }], context, now);
    assert.match(names[0].label, /2025/); assert.match(names[1].label, /2026/);
    assert.notEqual(names[0].label, names[1].label);
    assert.equal(names[0].preset, "custom");
    assert.deepEqual(view.preset("this-week", { timeZone: "Pacific/Honolulu", locale: "en-US" }, "2026-03-09T03:00:00Z"),
        { from: "2026-03-02", to: "2026-03-08" });
});
