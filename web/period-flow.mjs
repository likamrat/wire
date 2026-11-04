import { chatCopy } from "../lib/chat-copy.mjs";

// Uses the applied snapshot, never draft date inputs or inferred collection history.
export function createPeriodFlow(time, copy = chatCopy) {
    return function describe({ rows, filters, coverage, timeContext, now = new Date().toISOString(), session = false, stale = false, layer = "tool", unit = rows.length === 1 ? "Work IQ tool call" : "Work IQ tool calls" }) {
        const sessions = new Set(rows.map(row => row.sourceSessionId).filter(Boolean)).size;
        const requests = new Set(rows.map(row => row.scenarioId).filter(Boolean)).size;
        const format = value => time.formatDate(value, timeContext, true);
        const period = filters.from || filters.to
            ? `${filters.from ? format(filters.from) : "the beginning"} - ${filters.to ? format(filters.to) : "the latest evidence"}`
            : "all retained dates";
        const calendarDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value);
        const boundLabel = value => calendarDate(value) ? format(value) : time.formatTime(value, timeContext);
        const caption = filters.from && filters.to
            ? filters.from === filters.to ? boundLabel(filters.from)
                : calendarDate(filters.from) && calendarDate(filters.to)
                    ? `${time.formatDate(filters.from, timeContext, filters.from.slice(0, 4) !== filters.to.slice(0, 4))} - ${format(filters.to)}`
                    : `${boundLabel(filters.from)} - ${boundLabel(filters.to)}`
            : filters.from ? `From ${boundLabel(filters.from)}`
                : filters.to ? `Through ${boundLabel(filters.to)}` : "All dates";
        const recorder = layer === "http";
        const sources = recorder ? `${sessions.toLocaleString()} recorder source identit${sessions === 1 ? "y" : "ies"}` : copy.count(sessions);
        const countParts = [
            `${requests.toLocaleString()} ${recorder ? "record group" : "interaction"}${requests === 1 ? "" : "s"}`,
            recorder ? `${sessions.toLocaleString()} recorder sources` : copy.count(sessions),
        ];
        const missing = rows.filter(row => !row.sourceSessionId).length;
        const relationship = copy.relationship(requests, rows.length, unit, recorder);
        const summary = `${stale ? "Previous results: " : session ? recorder ? "This recorder source: " : "This Copilot chat: " : ""}${session ? "" : `${sources} / `}${relationship}.${missing ? ` ${missing.toLocaleString()} ${missing === 1 ? "record has" : "records have"} no source identity.` : ""}`;
        let warning = "", historyLink = false;
        if (filters.from || filters.to) {
            const requested = time.range(filters, timeContext.timeZone);
            const from = requested.from ? Date.parse(requested.from) : -Infinity;
            const to = requested.to ? Date.parse(requested.to) - (requested.toExclusive ? 1 : 0) : Infinity;
            // Future calendar days are selected, but cannot be missing past history.
            const elapsedTo = Math.min(to, Date.parse(time.instant(now)));
            if (from <= elapsedTo) {
                const checkedInstant = value => typeof value === "string" ? Date.parse(value) : NaN;
                const since = checkedInstant(coverage?.since), until = checkedInstant(coverage?.until);
                if (Number.isFinite(since) && Number.isFinite(until) && since <= until) {
                    if (from < since || elapsedTo > until) {
                        const outside = from > until || elapsedTo < since;
                        warning = `${outside ? "This period is" : "Some of this period is"} outside checked history; activity may be missing.`;
                        historyLink = true;
                    }
                } else {
                    warning = "Checked history is unknown; this view uses retained activity.";
                    historyLink = true;
                }
            }
        }
        return { sessions, requests, summary, caption, countParts, countText: countParts.join("; "), warning, historyLink,
            next: requests ? recorder ? `${period === "all retained dates" ? "All retained dates" : period} · Current filters; recorder groups are not Copilot requests.`
                : `${period === "all retained dates" ? "All retained dates" : period} · Current filters · Groups follow recorded messages.`
                : session ? "No request groups match this source and period. Try another period or inspect its coverage."
                    : "No collected request groups match. Try another period or clear a refinement; this is not proof that no activity occurred." };
    };
}
