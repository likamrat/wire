import test from "node:test";
import assert from "node:assert/strict";
import { time } from "../lib/time.mjs";
import { createRequestTiming } from "../web/request-timing.mjs";

const timing = createRequestTiming(time);
const context = { timeZone: "America/Los_Angeles", locale: "en-US" };

test("request time names the recorded message, never the call start or a request duration", () => {
    const source = {
        userPrompt: { sourceTimestamp: "2026-09-29T19:22:29Z", status: "partial" },
        capturedAt: "2026-09-29T19:22:44Z",
        toolCalls: [{ startedAt: "2026-09-29T19:22:44Z", completedAt: "2026-09-30T20:00:00Z", durationMs: 90000000 }],
    };
    const before = structuredClone(source);
    assert.equal(timing.summary(source, context), "Message recorded: Sep 29, 2026, 12:22 PM");
    source.userPrompt.sourceTimestamp = "2026-10-01T19:00:00Z";
    assert.equal(timing.summary(source, context), "Message recorded: Oct 1, 2026, 12:00 PM", "A late source timestamp is not replaced by a guessed start");
    source.userPrompt.sourceTimestamp = before.userPrompt.sourceTimestamp;
    assert.deepEqual(source, before);
});

test("missing or invalid message time selects only an actual earliest timed action across layers", () => {
    for (const sourceTimestamp of [undefined, null, "", "invalid", "2026-02-30T12:00:00Z", "2026-09-29T12:00:00"]) {
        const source = { userPrompt: { sourceTimestamp }, capturedAt: "2000-01-01T00:00:00Z",
            toolCalls: [{ startedAt: "invalid" }, { startedAt: "2026-10-02T01:00:00+05:30", completedAt: null }],
            graphActivities: [{ startedAt: "2026-09-29T19:22:44Z" }],
            httpRecords: [{ startedAt: "2026-09-30T19:00:00Z" }],
        };
        const before = structuredClone(source);
        assert.equal(timing.summary(source, context), "First timed action: Sep 29, 2026, 12:22 PM");
        assert.deepEqual(source, before);
    }
});

test("group capture, duration and completion never fabricate an unavailable message or start", () => {
    for (const source of [{}, { capturedAt: "2026-09-29T19:22:44Z" },
        { toolCalls: [{ startedAt: "invalid", completedAt: "2026-09-30T19:22:45Z", durationMs: 1000 }] }]) {
        assert.equal(timing.summary(source, context), "Request time not recorded");
    }
    assert.equal(time.formatMoment("invalid", context), "Time not recorded");
    assert.equal(time.formatMoment(null, context), "Time not recorded");
});

test("compact dates inherit each effective IANA context while exact values retain distinct DST offsets", () => {
    const source = { userPrompt: { sourceTimestamp: "2026-09-30T06:59:59Z" } };
    assert.equal(timing.summary(source, context), "Message recorded: Sep 29, 2026, 11:59 PM");
    assert.equal(timing.summary(source, { ...context, timeZone: "UTC" }), "Message recorded: Sep 30, 2026, 6:59 AM");
    assert.equal(timing.summary(source, { ...context, timeZone: "Asia/Kathmandu" }), "Message recorded: Sep 30, 2026, 12:44 PM");
    for (const [date, hours] of [["2026-03-08", 23], ["2026-11-01", 25]]) {
        const { from, to } = time.range({ from: date, to: date }, context.timeZone);
        assert.equal((Date.parse(to) - Date.parse(from)) / 3600000, hours);
        const before = time.formatTime(from, context), after = time.formatTime(to, context);
        assert.match(before, hours === 23 ? /GMT-8/ : /GMT-7/);
        assert.match(after, hours === 23 ? /GMT-7/ : /GMT-8/);
    }
    assert.equal(time.formatMoment("2026-11-01T08:30:00Z", context), time.formatMoment("2026-11-01T09:30:00Z", context));
    assert.notEqual(time.formatTime("2026-11-01T08:30:00Z", context), time.formatTime("2026-11-01T09:30:00Z", context));
});

test("origin and retained coverage are readable without promoting an inferred message to a verified user request", () => {
    assert.equal(timing.origin({ provenance: "recorded-user-message-origin-unverified" }), "Recorded message; author not verified");
    assert.equal(timing.origin({ provenance: "coordinator-message" }), "Coordinator message");
    assert.equal(timing.origin({ provenance: "unexpected-machine-code" }), "Origin not verified");
    for (const status of ["partial", "truncated"]) assert.equal(timing.coverage({ status, text: "Retained fragment" }), "Partial text; missing text is not reconstructed");
    assert.equal(timing.coverage({ status: "full", text: "" }), "Text not available");
    assert.equal(timing.coverage({ status: "unavailable", text: "Not authorized" }), "Text not available");
    assert.equal(timing.coverage({ status: "full", text: "Retained text" }), "Complete recorded text");
    assert.equal(timing.coverage({ status: "unexpected", text: "Retained text" }), "Text completeness not verified");
});
