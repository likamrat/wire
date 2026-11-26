// Screen display names for recorded model IDs. Formatting is exact: only a fully matched,
// vendor-prefixed ID gets a name; anything else is "Unrecognized model" and keeps its own row.
// Filters, frozen facts, saved reports and attribution always keep the recorded ID.
// Self-contained: the bundled shell serializes this function.
export function modelDisplayName(id) {
    if (typeof id !== "string" || !id.trim()) return { label: "Model not recorded", missing: true };
    const words = { mini: "mini", nano: "nano", pro: "Pro", flash: "Flash", lite: "Lite", codex: "Codex", max: "Max", turbo: "Turbo" };
    const tail = value => value ? value.slice(1).split("-").map(word => words[word]).join(" ") : "";
    const join = (...parts) => parts.filter(Boolean).join(" ");
    const tier = name => name[0].toUpperCase() + name.slice(1);
    const suffix = "((?:-(?:mini|nano|pro|flash|lite|codex|max|turbo))*)";
    const families = [
        [new RegExp("^gpt-(\\d+(?:\\.\\d+)?)" + suffix + "$"), (_, v, s) => join("GPT-" + v, tail(s))],
        [new RegExp("^gpt-4o" + suffix + "$"), (_, s) => join("GPT-4o", tail(s))],
        [/^o\d(?:-mini)?$/, name => name],
        [/^claude-(sonnet|opus|haiku)-(\d+(?:\.\d+)?)$/, (_, name, v) => `Claude ${tier(name)} ${v}`],
        [/^claude-(\d+(?:\.\d+)?)-(sonnet|opus|haiku)$/, (_, v, name) => `Claude ${v} ${tier(name)}`],
        [new RegExp("^gemini-(\\d+(?:\\.\\d+)?)" + suffix + "$"), (_, v, s) => join("Gemini " + v, tail(s))],
    ];
    for (const [pattern, format] of families) {
        const match = id.match(pattern);
        if (match) return { label: format(...match), recognized: true };
    }
    return { label: "Unrecognized model", recognized: false };
}