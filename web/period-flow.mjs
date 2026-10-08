import { chatCopy } from "../lib/chat-copy.mjs";

// Uses the applied snapshot, never draft date inputs or inferred collection history.
export function createPeriodFlow(time, copy = chatCopy) {
    return function describe({ rows, filters, coverage, timeContext, session = false, stale = false, layer = "tool", unit = rows.length === 1 ? "Work IQ tool call" : "Work IQ tool calls" }) {
        const sessions = new Set(rows.map(row => row.sourceSessionId).filter(Boolean)).size;
        const requests = new Set(rows.map(row => row.scenarioId).filter(Boolean)).size;
        const format = value => time.formatDate(value, timeContext, true);
        const period = filters.from || filters.to
            ? `${filters.from ? format(filters.from) : "the beginning"} - ${filters.to ? format(filters.to) : "the latest evidence"}`
            : "all retained dates";
        const recorder = layer === "http";
        const sources = recorder ? `${sessions.toLocaleString()} recorder source identit${sessions === 1 ? "y" : "ies"}` : copy.count(sessions);
        const missing = rows.filter(row => !row.sourceSessionId).length;
        const relationship = copy.relationship(requests, rows.length, unit, recorder);
        const summary = `${stale ? "Previous results: " : session ? recorder ? "This recorder source: " : "This Copilot chat: " : ""}${session ? "" : `${sources} / `}${relationship}.${missing ? ` ${missing.toLocaleString()} ${missing === 1 ? "record has" : "records have"} no source identity.` : ""}`;
        let warning = "", historyLink = false;
        if (filters.from || filters.to) {
            const localDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value) ? time.calendar(value) : time.day(value, timeContext.timeZone);
            const valid = value => typeof value === "string" && Number.isFinite(Date.parse(value));
            if (valid(coverage?.since) && valid(coverage?.until)) {
                const start = localDay(coverage.since), end = localDay(coverage.until), requested = time.range(filters, timeContext.timeZone);
                if (requested.from && Date.parse(requested.from) < Date.parse(coverage.since) || requested.to && Date.parse(requested.to) > Date.parse(coverage.until)) {
                    warning = `Last checked window: ${format(start)} - ${format(end)}; boundary days may be partial. Activity outside it may be missing. A date filter does not collect more history.`;
                    historyLink = true;
                }
            } else warning = "Collection coverage dates are unavailable. This period filters retained evidence only; it does not collect more history.";
        }
        return { sessions, requests, summary, warning, historyLink,
            next: requests ? recorder ? `${period === "all retained dates" ? "All retained dates" : period} · Current filters; recorder groups are not Copilot requests.`
                : `${period === "all retained dates" ? "All retained dates" : period} · Current filters · Groups follow recorded messages.`
                : session ? "No request groups match this source and period. Try another period or inspect its coverage."
                    : "No collected request groups match. Try another period or clear a refinement; this is not proof that no activity occurred." };
    };
}
