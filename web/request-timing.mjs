// Presentation only: neither a message association nor a timed action proves request bounds.
export function createRequestTiming(time, authorship) {
    function valid(value) {
        try { time.instant(value); return true; }
        catch (error) { if (!(error instanceof RangeError)) throw error; return false; }
    }
    function summary(scenario, context) {
        const message = scenario.userPrompt?.sourceTimestamp;
        if (valid(message)) return "Message recorded: " + time.formatMoment(message, context);
        const starts = [...scenario.toolCalls || [], ...scenario.graphActivities || [], ...scenario.httpRecords || []]
            .map(record => record.startedAt).filter(valid);
        if (!starts.length) return "Request time not recorded";
        const earliest = starts.reduce((first, value) => Date.parse(value) < Date.parse(first) ? value : first);
        return "First timed action: " + time.formatMoment(earliest, context);
    }
    function origin(source) {
        if (authorship) return authorship.label(source) + ". " + authorship.reason(source);
        if (source?.provenance === "coordinator-message") return "Coordinator message";
        if (source?.provenance === "recorded-user-message-origin-unverified") return "Recorded message; author not verified";
        if (source?.provenance === "human-authored") return "Recorded as human-authored";
        return "Origin not verified";
    }
    function coverage(source) {
        if (source?.status === "unavailable" || typeof source?.text !== "string" || !source.text.trim()) return "Text not available";
        if (source.status === "partial" || source.status === "truncated") return "Partial text; missing text is not reconstructed";
        return source.status === "full" ? "Complete recorded text" : "Text completeness not verified";
    }
    return { summary, origin, coverage };
}
