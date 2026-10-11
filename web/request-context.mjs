// Selection only. Inputs must already be authorized; this never looks up source text.
export function createRequestContext() {
    const eventId = prompt => typeof prompt?.sourceEventId === "string" && prompt.sourceEventId ? prompt.sourceEventId : null;
    const instant = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
    function compare(left, right) {
        const a = instant(left.at), b = instant(right.at);
        return a !== null && b !== null ? a - b : a !== null ? -1 : b !== null ? 1 : 0;
    }
    function select(records, anchorId) {
        const anchor = records.find(record => record.scenarioId === anchorId);
        if (!anchor) return { anchorId, groups: [], messages: [], gaps: ["The selected interaction is no longer retained."] };
        const gaps = [], neighbors = records.filter(record => record !== anchor && record.scenarioId !== anchorId
            && anchor.sourceSessionId && record.sourceSessionId === anchor.sourceSessionId);
        if (!anchor.sourceSessionId) gaps.push("Chat identity was not retained; surrounding groups cannot be linked.");
        else if (!eventId(anchor.userPrompt)) gaps.push("The selected message identity was not retained; preceding groups cannot be linked.");
        const follows = (before, after) => {
            const id = eventId(after.userPrompt);
            return id && before.followUpPrompts?.some(prompt => eventId(prompt) === id);
        };
        const chronologicallyLinked = (before, after) => {
            const a = instant(before.userPrompt?.sourceTimestamp), b = instant(after.userPrompt?.sourceTimestamp);
            return a !== null && b !== null && a <= b && eventId(before.userPrompt) !== eventId(after.userPrompt)
                && before.followUpPrompts.some(prompt => eventId(prompt) === eventId(after.userPrompt)
                    && instant(prompt.sourceTimestamp) === b);
        };
        const adjacent = direction => {
            const candidates = neighbors.filter(record => direction === "before" ? follows(record, anchor) : follows(anchor, record));
            if (candidates.length > 1) {
                gaps.push(`Multiple retained groups share the ${direction === "before" ? "preceding" : "following"} message link; none was added as adjacent context.`);
                return null;
            }
            const record = candidates[0];
            if (!record) return null;
            if (!(direction === "before" ? chronologicallyLinked(record, anchor) : chronologicallyLinked(anchor, record))) {
                gaps.push("A stored message link has missing or conflicting chronology; that neighboring group was not added.");
                return null;
            }
            return record;
        };
        const previous = adjacent("before"), next = adjacent("after");
        const groups = [
            ...(previous ? [{ scenario: previous, relation: "preceding" }] : []),
            { scenario: anchor, relation: "selected" },
            ...(next && next !== previous ? [{ scenario: next, relation: "following" }] : []),
        ];
        const originIds = new Set(groups.map(group => eventId(group.scenario.userPrompt)).filter(Boolean));
        const messages = [];
        for (const { scenario, relation } of groups) {
            messages.push({ key: `prompt:${scenario.scenarioId}`, scenarioId: scenario.scenarioId, kind: "prompt",
                at: scenario.userPrompt?.sourceTimestamp, source: scenario.userPrompt, relation });
            if (relation !== "selected") continue;
            for (const [index, prompt] of (scenario.followUpPrompts ?? []).entries()) {
                // The same retained event is shown once, as its own group's prompt.
                if (eventId(prompt) && originIds.has(eventId(prompt))) continue;
                messages.push({ key: `followup:${scenario.scenarioId}:${eventId(prompt) ?? index}`, scenarioId: scenario.scenarioId,
                    kind: "follow-up", at: prompt.sourceTimestamp, source: prompt, relation: "inferred-follow-up" });
            }
        }
        return {
            anchorId, groups, messages: messages.sort(compare), gaps,
            boundary: "Selected interaction and at most one linked group on either side. Links use the same recorded message ID within this chat, not inferred task boundaries.",
            limitation: "Available retained context only, not a complete conversation. The normal source keeps at most the nearest following message per group; other messages or replies may be missing.",
        };
    }
    return { select, compare };
}
