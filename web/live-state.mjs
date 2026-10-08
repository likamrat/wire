// Serialized into the page; collection updates never own disclosure or selection.
export function createLiveState() {
    return {
        observe(incoming, applied, { reviewing = false, editing = false, loading = false } = {}) {
            if (!Number.isSafeInteger(incoming) || incoming <= applied) return "unchanged";
            return reviewing || editing || loading ? "defer" : "refresh";
        },
    };
}
