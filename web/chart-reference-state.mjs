// Presentation only; accepted evidence and navigation remain client-owned.
export function createChartReferenceState() {
    const topics = ["outcomes", "time", "services", "models", "authors", "tools", "categories", "paths"];
    let current = { view: "closed", topic: "outcomes" };
    const value = () => ({ ...current });
    function validateTopic(topic) {
        if (!topics.includes(topic)) throw new TypeError("Choose a supported chart reference topic.");
    }
    return {
        value,
        open(topic = current.topic) {
            validateTopic(topic);
            current = { view: "guide", topic };
            return value();
        },
        showIndex() {
            if (current.view === "closed") throw new Error("Open chart help before choosing a topic.");
            current = { ...current, view: "index" };
            return value();
        },
        showData() {
            if (current.view === "closed") throw new Error("Open chart help before reading its exact data.");
            if (current.view === "index") throw new Error("Choose a chart guide before reading its exact data.");
            current = { ...current, view: "data" };
            return value();
        },
        back() {
            if (current.view !== "data") throw new Error("Return from exact chart data to its guide.");
            current = { ...current, view: "guide" };
            return value();
        },
        selectTopic(topic) {
            if (current.view === "closed") throw new Error("Open chart help before choosing a topic.");
            validateTopic(topic);
            current = { ...current, topic, view: current.view === "index" ? "guide" : current.view };
            return value();
        },
        close() {
            current = { ...current, view: "closed" };
            return value();
        },
    };
}
