// Serialized into the browser. Draft copies and consent never enter persistent storage.
export function createReportDraft() {
    let version = 0;
    let selection = "";
    let options = { promptMode: "masked", formats: ["html"], manualTerms: [], overrides: [] };
    return {
        options: () => structuredClone(options),
        token: () => version,
        current: (token) => token === version,
        invalidate: () => { version++; },
        clearSelection() {
            selection = "";
            options.overrides = [];
            version++;
        },
        synchronizeTime(timeContext, dateSelection) {
            if (JSON.stringify(options.timeContext) === JSON.stringify(timeContext) && JSON.stringify(options.dateSelection) === JSON.stringify(dateSelection)) return;
            options = { ...options, timeContext: structuredClone(timeContext), dateSelection: structuredClone(dateSelection) };
            version++;
        },
        select(ids) {
            const next = JSON.stringify([...ids].sort());
            if (selection !== next) {
                selection = next;
                options.overrides = [];
                version++;
            }
        },
        change(patch) {
            options = { ...options, ...structuredClone(patch) };
            version++;
        },
    };
}
