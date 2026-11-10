// Serialized into the browser shell; source IDs and recorded names stay untouched.
export function createChatCopy() {
    const valid = value => Number.isSafeInteger(value) && value >= 0;
    const plural = (value, noun) => `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;
    const unnamed = "Copilot chat name not recorded";
    function references(sessions, scenarios) {
        const sources = new Map((sessions || []).map(item => [item.sessionId, item.name]));
        for (const item of scenarios || []) if (item.sourceSessionId && !sources.has(item.sourceSessionId)) {
            sources.set(item.sourceSessionId, item.sourceSessionName || unnamed);
        }
        const names = new Map(), ids = [...sources.keys()];
        for (const name of sources.values()) names.set(name, (names.get(name) || 0) + 1);
        const stringIds = ids.every(id => typeof id === "string");
        const reverse = value => value.split("").reverse().join("");
        const shared = (a, b) => {
            let length = 0;
            while (b !== undefined && length < a.length && length < b.length && a[length] === b[length]) length++;
            return length;
        };
        let ordered;
        return (source, recorder = false) => {
            if (!source) return null;
            const { sessionId: id, name } = source;
            const sameName = name === name ? names.get(name) || 0 : 0;
            const ownName = id === id && sources.has(id) && sources.get(id) === name ? 1 : 0;
            if (name !== unnamed && sameName <= ownName) return null;
            let length = Math.min(8, id.length);
            if (length < id.length) {
                if (!stringIds || typeof id !== "string") {
                    while (length < id.length && ids.some(other => other !== id && other.endsWith(id.slice(-length)))) length++;
                } else {
                    // Reversed lexical neighbors share the longest suffix with this ID.
                    ordered ??= ids.map(reverse).sort();
                    const key = reverse(id);
                    let low = 0, high = ordered.length;
                    while (low < high) {
                        const middle = Math.floor((low + high) / 2);
                        if (ordered[middle] < key) low = middle + 1;
                        else high = middle;
                    }
                    const right = ordered[low] === key ? low + 1 : low;
                    length = Math.min(id.length, Math.max(8, shared(key, ordered[low - 1]) + 1, shared(key, ordered[right]) + 1));
                }
            }
            return `${recorder ? "Source" : "Chat"} ${length < id.length ? "..." : ""}${id.slice(-length)}`;
        };
    }
    return {
        nameLabel: "Copilot chat name",
        unnamed, references,
        requestMeaning: "A request group links activity to a recorded Copilot message, not an API request or a completed task. Follow-ups that trigger calls form separate groups; missing origins stay unverified.",
        count(value, qualified = false) {
            if (!valid(value)) return "Copilot chat count unavailable";
            return plural(value, `${qualified ? "GitHub " : ""}Copilot chat`);
        },
        groups(value, recorder = false) {
            if (!valid(value)) return "Request-group count unavailable";
            return plural(value, recorder ? "record group" : "request group");
        },
        relationship(groups, records, unit, recorder = false) {
            if (!valid(groups) || !valid(records)) return "Request and activity counts unavailable";
            return `${this.groups(groups, recorder)} with ${records.toLocaleString()} ${unit}`;
        },
    };
}

export const chatCopy = createChatCopy();
