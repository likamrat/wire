// Serialized into the browser. Draft copies and consent never enter persistent storage.
export function createReportDraft() {
    let version = 0;
    let selection = "";
    let basis;
    let options = { promptMode: "masked", formats: ["html"], manualTerms: [], overrides: [] };
    return {
        options: () => structuredClone(options),
        token: () => version,
        current: (token) => token === version,
        invalidate: () => { version++; },
        synchronizeBasis(snapshot, scope) {
            const ids = new Set(scope.requests.flatMap(request => request.aliases));
            const ordered = rows => rows.slice().sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
            const assessment = snapshot.assessment;
            const next = JSON.stringify([
                snapshot.boardId, snapshot.deletionVersion,
                ordered(scope.baseRequests), ordered(scope.requests),
                ordered(snapshot.scenarios.filter(scenario => ids.has(scenario.scenarioId))),
                assessment?.source, assessment?.consent, assessment?.capabilities,
                assessment?.basis?.consentRevision, assessment?.basis?.overrideRevision, assessment?.basis?.deletionEpoch,
                ordered((assessment?.catalog || []).filter(item => ids.has(item.scenarioId))),
                // The snapshot exposes pooled model results, not per-report evaluation dependencies.
                // A changed revision with model results therefore requires a fresh actual review.
                assessment?.overview?.metrics?.some(metric => metric.origin === "model-assessed") ? snapshot.revision : null,
            ]);
            const changed = basis !== undefined && basis !== next;
            basis = next;
            if (changed) version++;
            return changed;
        },
        clearSelection() {
            selection = "";
            basis = undefined;
            options.overrides = [];
            version++;
        },
        synchronizeTime(timeContext, dateSelection) {
            if (JSON.stringify(options.timeContext) === JSON.stringify(timeContext) && JSON.stringify(options.dateSelection) === JSON.stringify(dateSelection)) return false;
            options = { ...options, timeContext: structuredClone(timeContext), dateSelection: structuredClone(dateSelection) };
            version++;
            return true;
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
