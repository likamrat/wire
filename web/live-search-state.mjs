export function createLiveSearchState(contract) {
    const empty = () => ({ matches: { hits: [], receipt: null, total: 0 } });
    let value = { panelId: null, epoch: -1, requestId: -1, purpose: "navigation", types: [], ...empty(), state: "disconnected", status: null };
    function invalid(message) {
        value = { ...value, ...empty(), state: "unavailable", status: null };
        throw new TypeError(message);
    }
    return {
        snapshot: () => value,
        query(requestId, purpose, types) {
            const request = contract.query({ schemaVersion: contract.schemaVersion, query: "", requestId, purpose, types });
            value = { ...value, requestId, purpose, types: request.types, ...empty(), state: "queued" };
        },
        disconnect() { value = { ...value, panelId: null, epoch: -1, ...empty(), status: null, state: "disconnected" }; },
        receive(event) {
            if (event?.schemaVersion !== contract.schemaVersion) invalid("Search protocol changed. Reload this panel before searching again.");
            if (event.event === "results" && !contract.validResults(event)) {
                invalid("Search returned an invalid result set. Reconnect before searching again.");
            }
            if (event.event === "connected") value = { ...value, panelId: event.panelId, epoch: event.epoch, ...empty(), state: "ready" };
            else if (event.event === "fence" && event.panelId === value.panelId && event.epoch > value.epoch) {
                value = { ...value, epoch: event.epoch, ...empty(), status: null, state: event.reason === "indexing" ? "building"
                    : event.reason === "collected" && value.purpose === "navigation" ? "refreshing" : "stale" };
            }
            else if (event.event === "results" && event.panelId === value.panelId && event.epoch === value.epoch
                && event.requestId === value.requestId) {
                if (event.purpose !== value.purpose
                    || JSON.stringify(event.matches.receipt.queryTypes) !== JSON.stringify(value.types)) {
                    invalid("Search returned an invalid result set. Reconnect before searching again.");
                }
                value = { ...value, matches: event.matches, status: event.status,
                    state: event.matches.total ? "ready"
                        : contract.completeCoverage(event.status?.corpus, event.matches.receipt.queryTypes) ? "no-match" : "incomplete" };
            }
            else if (event.event === "status" && event.panelId === value.panelId && event.epoch === value.epoch
                && (event.requestId === value.requestId || event.requestId === undefined && event.state === "unavailable")) {
                const invalid = ["unavailable", "stale", "closed", "changing"].includes(event.state);
                value = { ...value, state: event.state, status: event.status ?? value.status,
                    ...(invalid ? empty() : {}) };
            }
            return value;
        },
    };
}
