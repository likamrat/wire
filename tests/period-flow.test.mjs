import test from "node:test";
import assert from "node:assert/strict";
import { createPeriodFlow } from "../web/period-flow.mjs";
import { time } from "../lib/time.mjs";

const describe = createPeriodFlow(time), timeContext = time.normalize({ timeZone: "America/Los_Angeles", locale: "en-US" });
const rows = [{ scenarioId: "a", sourceSessionId: "one" }, { scenarioId: "a", sourceSessionId: "one" }, { scenarioId: "b", sourceSessionId: "two" }];
test("period feedback counts exact distinct canonical request owners and source sessions", () => {
    const result = describe({ rows, filters: { from: "2026-07-29", to: "2026-10-05" }, coverage: { since: "2026-09-05T07:00:00Z", until: "2026-10-05T13:00:00Z" }, timeContext });
    assert.equal(result.sessions, 2);
    assert.equal(result.requests, 2);
    assert.equal(result.summary, "2 Copilot chats / 2 request groups with 3 Work IQ tool calls.");
    assert.match(result.next, /^Jul 29, 2026 - Oct 5, 2026.*Current filters/);
    assert.match(result.warning, /Sep 5, 2026 - Oct 5, 2026.*may be missing.*does not collect/);
    assert.equal(result.historyLink, true);
});
test("coverage boundaries use local IANA days without claiming full-day or complete collection", () => {
    const result = describe({ rows, filters: { from: "2026-09-04", to: "2026-10-04" }, coverage: { since: "2026-09-05T00:00:00Z", until: "2026-10-05T00:00:00Z" }, timeContext });
    assert.match(result.warning, /boundary days may be partial/);
    const inside = describe({ rows, filters: { from: "2026-09-05", to: "2026-10-03" }, coverage: { since: "2026-09-05T00:00:00Z", until: "2026-10-05T00:00:00Z" }, timeContext });
    assert.equal(inside.warning, "");
    const unknown = describe({ rows: [], filters: { from: "2026-07-29" }, coverage: {}, timeContext });
    assert.match(unknown.warning, /coverage dates are unavailable/);
    assert.match(unknown.next, /not proof that no activity occurred/);
    assert.equal(unknown.historyLink, false);
});
test("stale results cannot masquerade as newly applied scope, and analysis does not force a wizard", () => {
    const result = describe({ rows, filters: {}, coverage: {}, timeContext, stale: true });
    assert.match(result.summary, /^Previous results:/);
    const analysis = describe({ rows: rows.slice(0, 2), filters: {}, coverage: {}, timeContext, session: true });
    assert.match(analysis.summary, /^This Copilot chat: 1 request group with 2 Work IQ tool calls/);
    assert.match(analysis.next, /Groups follow recorded messages/);
});
