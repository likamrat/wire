import test from "node:test";
import assert from "node:assert/strict";
import { createPeriodFlow } from "../web/period-flow.mjs";
import { time } from "../lib/time.mjs";

const describe = createPeriodFlow(time), timeContext = time.normalize({ timeZone: "America/Los_Angeles", locale: "en-US" });
const rows = [{ scenarioId: "a", sourceSessionId: "one" }, { scenarioId: "a", sourceSessionId: "one" }, { scenarioId: "b", sourceSessionId: "two" }];
test("checked history compares elapsed selected time, not future calendar days", () => {
    const now = "2026-10-13T19:00:00Z";
    const coverage = { since: "2026-09-13T18:00:00Z", until: now };
    const model = (filters, checked = coverage) => describe({ rows, filters, coverage: checked, timeContext, now });
    assert.equal(model({ from: "2026-10-01", to: "2026-10-31" }).warning, "");
    assert.equal(model({ from: "2026-10-13", to: "2026-10-13" }).warning, "");
    assert.equal(model({ from: "2026-11-01", to: "2026-11-30" }, null).warning, "");
    assert.equal(model({ from: "2026-09-14", to: "2026-10-12" }).warning, "");
    assert.equal(model({ from: "2026-09-13", to: "2026-10-12" }).warning,
        "Some of this period is outside checked history; activity may be missing.");
    assert.equal(model({ from: "2026-10-01", to: "2026-10-31" }, { ...coverage, until: "2026-10-13T18:00:00Z" }).warning,
        "Some of this period is outside checked history; activity may be missing.");
    assert.equal(model({ from: "2026-09-01", to: "2026-09-12" }).warning,
        "This period is outside checked history; activity may be missing.");
    assert.equal(model({ from: "2026-10-01", to: "2026-10-12" }, null).warning,
        "Checked history is unknown; this view uses retained activity.");
    assert.equal(model({}).warning, "");
});
test("period feedback counts exact distinct canonical request owners and source sessions", () => {
    const result = describe({ rows, filters: { from: "2026-07-29", to: "2026-10-05" }, coverage: { since: "2026-09-05T07:00:00Z", until: "2026-10-05T13:00:00Z" }, timeContext });
    assert.equal(result.sessions, 2);
    assert.equal(result.requests, 2);
    assert.equal(result.summary, "2 Copilot chats / 2 request groups with 3 Work IQ tool calls.");
    assert.deepEqual(result.countParts, ["2 interactions", "2 Copilot chats"]);
    assert.equal(result.countText, "2 interactions; 2 Copilot chats");
    assert.match(result.next, /^Jul 29, 2026 - Oct 5, 2026.*Current filters/);
    assert.equal(result.warning, "Some of this period is outside checked history; activity may be missing.");
    assert.equal(result.historyLink, true);
});

test("scope count peers retain separate recorder and unknown-source populations", () => {
    const recorder = describe({ rows, filters: {}, timeContext, layer: "http", unit: "owned HTTP records" });
    assert.deepEqual(recorder.countParts, ["2 record groups", "2 recorder sources"]);
    assert.equal(recorder.countText, "2 record groups; 2 recorder sources");
    const unknown = describe({ rows: [{ scenarioId: "unknown" }], filters: {}, timeContext });
    assert.deepEqual(unknown.countParts, ["1 interaction", "0 Copilot chats"]);
    assert.match(unknown.summary, /1 record has no source identity/);
});
test("coverage boundaries use local IANA days without claiming full-day or complete collection", () => {
    const result = describe({ rows, filters: { from: "2026-09-04", to: "2026-10-04" }, coverage: { since: "2026-09-05T00:00:00Z", until: "2026-10-05T00:00:00Z" }, timeContext });
    assert.equal(result.warning, "Some of this period is outside checked history; activity may be missing.");
    const inside = describe({ rows, filters: { from: "2026-09-05", to: "2026-10-03" }, coverage: { since: "2026-09-05T00:00:00Z", until: "2026-10-05T00:00:00Z" }, timeContext });
    assert.equal(inside.warning, "");
    const unknown = describe({ rows: [], filters: { from: "2026-07-29" }, coverage: {}, timeContext });
    assert.equal(unknown.warning, "Checked history is unknown; this view uses retained activity.");
    assert.match(unknown.next, /not proof that no activity occurred/);
    assert.equal(unknown.historyLink, true);
});
test("stale results cannot masquerade as newly applied scope, and analysis does not force a wizard", () => {
    const result = describe({ rows, filters: {}, coverage: {}, timeContext, stale: true });
    assert.match(result.summary, /^Previous results:/);
    const analysis = describe({ rows: rows.slice(0, 2), filters: {}, coverage: {}, timeContext, session: true });
    assert.match(analysis.summary, /^This Copilot chat: 1 request group with 2 Work IQ tool calls/);
    assert.match(analysis.next, /Groups follow recorded messages/);
});

test("headline captions preserve exact applied dates, open bounds, cross-year spans and instant offsets", () => {
    const caption = (filters, context = timeContext) => describe({ rows, filters, timeContext: context }).caption;
    assert.equal(caption({}), "All dates");
    assert.equal(caption({ from: "2026-10-13", to: "2026-10-13" }), "Oct 13, 2026");
    assert.equal(caption({ from: "2026-10-01", to: "2026-10-31" }), "Oct 1 - Oct 31, 2026");
    assert.equal(caption({ from: "2026-12-28", to: "2027-01-03" }), "Dec 28, 2026 - Jan 3, 2027");
    assert.equal(caption({ from: "2026-10-01" }), "From Oct 1, 2026");
    assert.equal(caption({ to: "2026-10-31" }), "Through Oct 31, 2026");
    const instants = { from: "2026-11-01T08:30:00Z", to: "2026-11-01T09:30:00Z" };
    assert.equal(caption(instants), `${time.formatTime(instants.from, timeContext)} - ${time.formatTime(instants.to, timeContext)}`);
    assert.match(caption(instants), /GMT-7.*GMT-8/);
    const french = { ...timeContext, locale: "fr-FR" };
    assert.equal(caption({ from: "2026-10-13", to: "2026-10-13" }, french), time.formatDate("2026-10-13", french, true));
});

test("partial boundary instants stay distinct from full civil days, unknown windows and future-only dates", () => {
    const now = "2026-10-13T19:00:00Z";
    const filters = { from: "2026-10-01", to: "2026-10-01" };
    const model = (coverage, dates = filters, context = timeContext) => describe({ rows, filters: dates, coverage, timeContext: context, now });
    const full = { since: "2026-10-01T07:00:00Z", until: "2026-10-02T07:00:00Z" };
    assert.equal(model(full).warning, "");
    assert.equal(model({ ...full, until: "2026-10-02T06:59:59.999Z" }).warning, "");
    assert.match(model({ ...full, since: "2026-10-01T07:00:00.001Z" }).warning, /^Some of/);
    assert.match(model({ ...full, until: "2026-10-02T06:59:59.998Z" }).warning, /^Some of/);
    assert.match(model(full, filters, { ...timeContext, timeZone: "UTC" }).warning, /^Some of/);
    assert.match(model(full, { from: "2026-09-30", to: "2026-09-30" }).warning, /^This period/);
    assert.equal(model(full, { from: full.since, to: full.until }).warning, "");
    assert.match(model(full, { from: "2026-09-30T07:00:00Z", to: full.since }).warning, /^Some of/,
        "An inclusive instant end can overlap the first checked instant.");
    for (const coverage of [null, {}, { since: full.since }, { since: "invalid", until: full.until },
        { since: full.until, until: full.since }, { since: 0, until: full.until }]) {
        assert.match(model(coverage).warning, /^Checked history is unknown/);
        assert.equal(model(coverage, { from: "2026-10-14" }).warning, "");
    }
    assert.match(model(full, { to: "2026-10-01" }).warning, /^Some of/);
    assert.match(model(full, { from: "2026-10-01" }).warning, /^Some of/);
});
