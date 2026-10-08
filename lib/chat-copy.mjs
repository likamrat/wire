// Serialized into the browser shell; source IDs and recorded names stay untouched.
export function createChatCopy() {
    const valid = value => Number.isSafeInteger(value) && value >= 0;
    const plural = (value, noun) => `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;
    return {
        nameLabel: "Copilot chat name",
        unnamed: "Copilot chat name not recorded",
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
