import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createTimeContext } from "../../lib/time.mjs";
import { buildActivityAnalytics, buildActivitySelection, getActivityDrilldown } from "../../lib/activity-analytics.mjs";
import { validateAnalyticsInput } from "../../lib/analytics-input.mjs";
import { fixture } from "../support/helpers.mjs";
import { createActivityProjection } from "../../lib/activity-projection.mjs";

const time = createTimeContext();
const context = (timeZone) => ({ timeZone, locale: "en-US" });

test("calendar work is bounded before expanding a century of empty daily dates", () => {
    let midnights = 0;
    const projection = createActivityProjection({ ...time, midnight(...args) {
        assert.ok(++midnights <= 182, "A calendar window must bound midnight work before allocation");
        return time.midnight(...args);
    } }, null, []);
    const points = projection.calendarBuckets(["1926-11-16", "2026-11-16"], "day", context("UTC"), {}, {});
    assert.ok(points.length <= 90);
    assert.equal(points.at(-1).date, "2026-11-16");
    const before = midnights;
    assert.throws(() => projection.calendarWindow(["1926-11-16", "2026-11-16"], "day", context("UTC"), {}, {}, undefined, 400, true),
        /Comparison timeline exceeds 400/);
    assert.equal(midnights, before, "Unsupported complete comparison refuses before materializing calendar boundaries");
});

test("sparse calendar output stays fixed as the retained span grows, and row selection has no calendar", () => {
    for (const days of [3653, 36526, 50000]) {
        const last = "2026-11-16", first = time.addDays(last, 1 - days);
        const records = [first, last].map((date, index) => {
            const record = fixture(`bounded-calendar-${index}`);
            record.capturedAt = date + "T12:00:00Z"; record.toolCalls[0].startedAt = record.capturedAt;
            return record;
        });
        const input = { bucket: "day", timeContext: context("UTC"), filters: { from: first, to: last } };
        const selected = buildActivitySelection(records, input), analytics = buildActivityAnalytics(records, input);
        assert.deepEqual(selected.rows, analytics.rows);
        assert.deepEqual(Object.keys(selected).sort(), ["exclusions", "rows"]);
        assert.equal(analytics.timeSeries.window.total, days);
        assert.equal(analytics.timeSeries.points.length, 90);
        assert.equal(analytics.timeSeries.totals.count, 2);
        assert.ok(JSON.stringify(analytics.timeSeries).length < 40000);
        const firstWindow = buildActivityAnalytics(records, { ...input, timelineFrom: first });
        assert.equal(firstWindow.timeSeries.points[0].date, first);
        assert.equal(firstWindow.timeSeries.points[0].total, 1);
        assert.deepEqual(firstWindow.rows, selected.rows);
    }
});

describe("civil date/time contract", () => {
    test("date presets share inclusive display-zone boundaries, including DST", () => {
        const now = "2026-03-09T06:00:00Z", zone = "America/Los_Angeles";
        assert.deepEqual(time.preset("7", zone, now), { from: "2026-03-02", to: "2026-03-08" });
        assert.deepEqual(time.preset("30", zone, now), { from: "2026-02-07", to: "2026-03-08" });
        assert.equal(time.preset("custom", zone, now), null);
        assert.equal(time.preset("capture", zone, now), null);
    });

    test("Today, This week and This month select local calendar periods, not elapsed durations", () => {
        const zone = "America/Los_Angeles", now = "2026-03-09T06:00:00Z";
        assert.deepEqual(time.preset("day", zone, now), { from: "2026-03-08", to: "2026-03-08" });
        assert.deepEqual(time.preset("week", zone, now), { from: "2026-03-02", to: "2026-03-08" });
        assert.deepEqual(time.preset("month", zone, now), { from: "2026-03-01", to: "2026-03-08" });
        assert.deepEqual(time.preset("week", "UTC", now), { from: "2026-03-09", to: "2026-03-09" });
        assert.deepEqual(time.preset("week", zone, "2026-01-01T12:00:00Z"), { from: "2025-12-29", to: "2026-01-01" });
        assert.deepEqual(time.preset("month", zone, "2024-02-29T12:00:00Z"), { from: "2024-02-01", to: "2024-02-29" });
        for (const range of ["day", "week", "month"]) {
            const selection = { range, ...time.preset(range, zone, now) };
            assert.deepEqual(time.selection(selection), selection);
            assert.throws(() => time.selection({ range }), /boundaries/);
        }
    });

    test("named-zone local days use DST boundaries, not fixed 24-hour offsets", () => {
        assert.deepEqual(time.range({ from: "2026-03-08", to: "2026-03-08" }, "America/Los_Angeles"), {
            from: "2026-03-08T08:00:00.000Z", to: "2026-03-09T07:00:00.000Z", toExclusive: true,
        });
        const projection = createActivityProjection(time, null, []);
        const calendar = projection.calendarWindow(["2011-12-29", "2012-01-02"], "day", context("Pacific/Apia"), {}, {}, "2011-12-30");
        assert.equal(calendar.points[0].date, "2011-12-30", "A civil window anchor does not skip an empty date with no local midnight");
    });

    test("winter/summer, midnight crossing and fractional offsets follow named-zone rules", () => {
        for (const [value, zone, day, offset] of [
            ["2026-01-01T07:30:00Z", "America/Los_Angeles", "2025-12-31", "GMT-8"],
            ["2026-07-01T06:30:00Z", "America/Los_Angeles", "2026-06-30", "GMT-7"],
            ["2026-01-01T20:00:00Z", "Asia/Kolkata", "2026-01-02", "GMT+5:30"],
            ["2026-01-01T20:00:00Z", "Asia/Kathmandu", "2026-01-02", "GMT+5:45"],
            ["2026-01-01T07:30:00Z", "UTC", "2026-01-01", "GMT"],
        ]) {
            assert.equal(time.day(value, zone), day);
            assert.ok(time.formatTime(value, context(zone)).includes(offset));
        }
        assert.equal(time.formatDate("2026-01-01", context("America/Los_Angeles"), true), "Jan 1, 2026", "Date-only labels are calendar dates, not UTC instants");
        assert.equal(time.formatDate("2026-01-01", { timeZone: "UTC", locale: "en-GB" }, true), "1 Jan 2026");
    });

    test("local ranges include 23/25 hour days and month/year/leap transitions", () => {
        for (const [from, to, start, end] of [
            ["2026-11-01", "2026-11-01", "2026-11-01T07:00:00.000Z", "2026-11-02T08:00:00.000Z"],
            ["2024-02-29", "2024-02-29", "2024-02-29T08:00:00.000Z", "2024-03-01T08:00:00.000Z"],
            ["2025-12-31", "2026-01-01", "2025-12-31T08:00:00.000Z", "2026-01-02T08:00:00.000Z"],
        ]) assert.deepEqual(time.range({ from, to }, "America/Los_Angeles"), { from: start, to: end, toExclusive: true });
        assert.equal(time.bucketDate("2026-01-01T07:00:00Z", "week", "America/Los_Angeles"), "2025-12-29");
        assert.equal(time.bucketDate("2026-01-01T07:00:00Z", "month", "America/Los_Angeles"), "2025-12-01");
        assert.equal(time.midnight("2018-11-04", "America/Sao_Paulo"), "2018-11-04T03:00:00.000Z", "Midnight DST gap starts at first valid local time");
        assert.equal(time.midnight("2011-12-30", "Pacific/Apia"), time.midnight("2011-12-31", "Pacific/Apia"), "Skipped civil day is empty");
    });

    test("strict time context/date validation and explicit unavailable browser fallback", () => {
        for (const timeZone of ["invalid", "", "+05:30", "GMT-7", "PST", "America/NotAZone", null]) assert.throws(() => validateAnalyticsInput({ timeContext: { timeZone, locale: "en-US" } }), e => e.status === 400);
        for (const from of ["2026-02-29", "2026-04-31", "2026-01-01T12:00:00", "2026-01-01T24:00:00Z", "October 1, 2026"]) assert.throws(() => validateAnalyticsInput({ filters: { from } }), e => e.status === 400);
        assert.throws(() => validateAnalyticsInput({ timeContext: { timeZone: "UTC", locale: "invalid_locale" } }), e => e.status === 400);
        const native = Intl.DateTimeFormat;
        try {
            Intl.DateTimeFormat = function (...args) {
                if (!args.length) return { resolvedOptions: () => ({ timeZone: undefined, locale: "en-GB" }) };
                return new native(...args);
            };
            Intl.DateTimeFormat.supportedLocalesOf = native.supportedLocalesOf;
            const detected = time.detect();
            assert.deepEqual(detected, { timeZone: "UTC", locale: "en-GB", timeZoneFallback: true, localeFallback: false });
            assert.match(time.label(detected), /fallback.*unavailable/);
        } finally { Intl.DateTimeFormat = native; }
    });

    function recordsAt(values) {
        return values.map((startedAt, index) => {
            const record = fixture("time-" + index);
            record.toolCalls[0].startedAt = startedAt;
            record.userPrompt.text = "RAW 2026-03-08T08:00:00Z must not be rewritten";
            return record;
        });
    }

    test("same instants regroup without changed totals; bucket drilldown exactly matches filtered rows", () => {
        const records = recordsAt(["2026-03-08T07:59:59Z", "2026-03-08T08:00:00Z", "2026-03-08T09:59:59Z", "2026-03-08T10:00:00Z", "2026-03-09T06:59:59Z", "2026-03-09T07:00:00Z"]);
        const before = structuredClone(records);
        const utc = buildActivityAnalytics(records, { bucket: "day", timeContext: context("UTC") });
        const local = buildActivityAnalytics(records, { bucket: "day", timeContext: context("America/Los_Angeles") });
        assert.equal(utc.totals.count, local.totals.count);
        assert.deepEqual(utc.timeSeries.points.map(p => p.total), [4, 2]);
        assert.deepEqual(local.timeSeries.points.map(p => p.total), [1, 4, 1]);
        for (const bucket of ["day", "week", "month"]) {
            const options = { bucket, timeContext: context("America/Los_Angeles"), filters: { from: "2026-03-08", to: "2026-03-08" } };
            const a = buildActivityAnalytics(records, options);
            assert.equal(a.totals.count, 4);
            for (const point of a.timeSeries.points) {
                const drilled = buildActivityAnalytics(records, { ...options, filters: { from: point.from, to: point.to } });
                assert.deepEqual(drilled.rows.map(r => r.id), getActivityDrilldown(a, point.date).map(r => r.id));
                assert.equal(drilled.totals.count, point.total);
            }
        }
        const repeated = buildActivityAnalytics(recordsAt(["2026-11-01T08:30:00Z", "2026-11-01T09:30:00Z", "2026-11-02T07:59:59Z", "2026-11-02T08:00:00Z"]), { timeContext: context("America/Los_Angeles"), filters: { from: "2026-11-01", to: "2026-11-01" } });
        assert.equal(repeated.totals.count, 3);
        assert.deepEqual(records, before);
    });

    test("daily timelines span more than 400 days without losing honest gaps or undated counts", () => {
        const from = "2025-01-01", to = time.addDays(from, 401);
        const records = recordsAt([from + "T12:00:00Z", to + "T12:00:00Z", null]);
        records.at(-1).capturedAt = null;
        const daily = buildActivityAnalytics(records, { timeContext: context("UTC") });
        assert.equal(daily.timeSeries.bucket, "day");
        assert.equal(daily.timeSeries.points.length, 90);
        assert.equal(daily.timeSeries.window.total, 402);
        assert.equal(daily.timeSeries.window.offset, 312);
        assert.equal(daily.timeSeries.undatedCount, 1);
        assert.equal(daily.timeSeries.points.reduce((sum, point) => sum + point.total, 0), 1);
        assert.equal(daily.timeSeries.totals.count, 2);
        assert.equal(daily.totals.count, 3);
        assert.deepEqual(daily.timeSeries.points.filter(point => point.total).map(point => point.date), [to]);
        const seen = new Set();
        for (let offset = 0; offset < 402; offset += 90) {
            const page = buildActivityAnalytics(records, { timelineFrom: time.addDays(from, offset), timeContext: context("UTC") });
            assert.ok(page.timeSeries.points.length <= 90);
            assert.equal(page.totals.count, 3);
            for (const point of page.timeSeries.points) {
                seen.add(point.date);
                assert.equal(point.total, point.drilldownIds.length);
            }
        }
        assert.equal(seen.size, 402, "Every day is reachable without changing membership or granularity");
        assert.deepEqual(buildActivitySelection(records, { timeContext: context("UTC") }).rows, daily.rows);
        assert.match(daily.timeSeries.gapMeaning, /not proof no activity occurred/);
        for (const bucket of ["week", "month"]) {
            const grouped = buildActivityAnalytics(records, { bucket, timeContext: context("UTC") });
            assert.equal(grouped.timeSeries.bucket, bucket);
            assert.equal(grouped.timeSeries.points.reduce((sum, point) => sum + point.total, 0), 2);
        }
        const bounded = buildActivityAnalytics(records, { timeContext: context("UTC"), filters: { from: "2025-01-01", to: "2025-01-02" } });
        assert.equal(bounded.totals.count, 1);
        assert.equal(bounded.timeSeries.undatedCount, 0);
        assert.equal(bounded.timeSeries.points[0].from, from);
        assert.equal(bounded.timeSeries.points[0].to, from);
    });
});
