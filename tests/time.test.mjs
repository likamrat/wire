import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createTimeContext } from "../lib/time.mjs";
import { buildActivityAnalytics, getActivityDrilldown } from "../lib/activity-analytics.mjs";
import { validateAnalyticsInput } from "../lib/analytics-input.mjs";
import { fixture } from "./helpers.mjs";

const time = createTimeContext();
const context = (timeZone) => ({ timeZone, locale: "en-US" });

describe("civil date/time contract", () => {
    test("named-zone local days use DST boundaries, not fixed 24-hour offsets", () => {
        assert.deepEqual(time.range({ from: "2026-03-08", to: "2026-03-08" }, "America/Los_Angeles"), {
            from: "2026-03-08T08:00:00.000Z", to: "2026-03-09T07:00:00.000Z", toExclusive: true,
        });
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
});
