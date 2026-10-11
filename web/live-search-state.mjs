export function createLiveSearchState() {
    let value = { panelId: null, epoch: -1, requestId: -1, hits: [], receipt: null, state: "disconnected", status: null };
    return {
        snapshot: () => value,
        query(requestId) { value = { ...value, requestId, hits: [], receipt: null, state: "queued" }; },
        disconnect() { value = { ...value, panelId: null, epoch: -1, hits: [], receipt: null, status: null, state: "disconnected" }; },
        receive(event) {
            if (event.event === "connected") value = { ...value, panelId: event.panelId, epoch: event.epoch, hits: [], receipt: null, state: "ready" };
            else if (event.event === "fence" && event.panelId === value.panelId && event.epoch > value.epoch) {
                value = { ...value, epoch: event.epoch, hits: [], receipt: null, status: null, state: event.reason === "indexing" ? "building" : "stale" };
            }
            else if (event.event === "results" && event.panelId === value.panelId && event.epoch === value.epoch
                && event.receipt?.requestId === value.requestId) {
                value = { ...value, hits: event.hits, receipt: event.receipt, status: event.status,
                    state: event.hits.length ? "ready" : "no-match" };
            }
            else if (event.event === "status" && event.panelId === value.panelId && event.epoch === value.epoch
                && (event.requestId === value.requestId || event.requestId === undefined && event.state === "unavailable")) {
                const invalid = ["unavailable", "stale", "closed", "changing"].includes(event.state);
                value = { ...value, state: event.state, status: event.status ?? value.status,
                    ...(invalid ? { hits: [], receipt: null } : {}) };
            }
            return value;
        },
    };
}
